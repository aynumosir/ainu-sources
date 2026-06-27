// Point-in-time backup of the live Turso DB → a timestamped SQL dump.
// The DB is the durable source of truth now, so snapshot it BEFORE any reseed
// or migration.
//
// SECURITY: the dump includes Better-Auth tables (emails, sessions, OAuth
// tokens, password hashes). It is therefore written OUT OF THE REPO by default
// and encrypted at rest when an encryption tool + key is configured.
//
// Destination (first match wins):
//   AINU_BACKUP_DIR=<path>     explicit out-of-repo directory
//   ALLOW_IN_REPO_BACKUP=1     legacy scripts/data/backups (gitignored)
//   else                       ~/.ainu-sources/backups
// Writing inside the repo workspace is refused unless ALLOW_IN_REPO_BACKUP=1.
//
// Encryption at rest (first match wins; best-effort, never fails the backup):
//   AINU_BACKUP_AGE_RECIPIENT=<age1…>   age -r  → *.sql.age
//   AINU_BACKUP_GPG_RECIPIENT=<keyid>   gpg -e  → *.sql.gpg
//   AINU_BACKUP_PASSPHRASE=<pass>       gpg -c  → *.sql.gpg (symmetric)
//   else                                plaintext *.sql + loud warning
//
// Restore into a fresh db:
//   turso db create ainu-sources-restore
//   age -d -i key.txt prod-<ts>.sql.age | turso db shell ainu-sources-restore
//   gpg -d            prod-<ts>.sql.gpg | turso db shell ainu-sources-restore
//   turso db shell ainu-sources-restore < prod-<ts>.sql
//
// Run: bun run backup   (uses the `turso` CLI; auth via your turso login)
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DB = process.env.TURSO_DB ?? 'ainu-sources';

// --- Destination: out of the repo unless explicitly overridden ---------------
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowInRepo = process.env.ALLOW_IN_REPO_BACKUP === '1';
const dir = path.resolve(
	process.env.AINU_BACKUP_DIR ??
		(allowInRepo
			? path.join(repoRoot, 'scripts/data/backups')
			: path.join(homedir(), '.ainu-sources', 'backups'))
);

const insideRepo = dir === repoRoot || dir.startsWith(repoRoot + path.sep);
if (insideRepo && !allowInRepo) {
	console.error(
		`✗ Refusing to write backup inside the repo workspace:\n    ${dir}\n` +
			`  Dumps contain Better-Auth secrets (emails, sessions, OAuth tokens, password hashes).\n` +
			`  Set AINU_BACKUP_DIR=<out-of-repo path>, or ALLOW_IN_REPO_BACKUP=1 to override.`
	);
	process.exit(1);
}

mkdirSync(dir, { recursive: true, mode: 0o700 });

const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const out = path.join(dir, `prod-${ts}.sql`);

console.log(`Dumping ${DB} via turso CLI…`);
// argv form (not a shell string) so DB can never be shell-interpolated.
const dump = execFileSync('turso', ['db', 'shell', DB, '.dump'], { maxBuffer: 1 << 30 }).toString();

// Sanity-check before trusting it as a backup — never write a truncated/empty dump.
if (!dump.includes('CREATE TABLE') || !/INSERT INTO ["']?sources/.test(dump)) {
	console.error('✗ Dump looks empty or invalid (no sources INSERTs) — aborting, not writing.');
	process.exit(1);
}

writeFileSync(out, dump, { mode: 0o600 });

// --- At-rest encryption: best-effort, never fail the backup ------------------
const has = (bin: string): boolean => {
	try {
		execFileSync(bin, ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
};

const ageRcpt = process.env.AINU_BACKUP_AGE_RECIPIENT;
const gpgRcpt = process.env.AINU_BACKUP_GPG_RECIPIENT;
const passphrase = process.env.AINU_BACKUP_PASSPHRASE;

let finalPath = out;
let restore = `turso db shell <new> < ${out}`;
try {
	if (ageRcpt && has('age')) {
		finalPath = `${out}.age`;
		execFileSync('age', ['-r', ageRcpt, '-o', finalPath, out]);
		chmodSync(finalPath, 0o600);
		unlinkSync(out);
		restore = `age -d -i <identity> ${finalPath} | turso db shell <new>`;
	} else if (gpgRcpt && has('gpg')) {
		finalPath = `${out}.gpg`;
		execFileSync('gpg', [
			'--batch', '--yes', '--trust-model', 'always',
			'--encrypt', '--recipient', gpgRcpt, '--output', finalPath, out
		]);
		chmodSync(finalPath, 0o600);
		unlinkSync(out);
		restore = `gpg -d ${finalPath} | turso db shell <new>`;
	} else if (passphrase && has('gpg')) {
		finalPath = `${out}.gpg`;
		execFileSync(
			'gpg',
			['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '-c', '--output', finalPath, out],
			{ input: passphrase }
		);
		chmodSync(finalPath, 0o600);
		unlinkSync(out);
		restore = `gpg -d ${finalPath} | turso db shell <new>`;
	} else {
		console.warn(
			'⚠ Backup is UNENCRYPTED. It contains Better-Auth secrets (emails, sessions,\n' +
				'  OAuth tokens, password hashes). Configure one of:\n' +
				'    AINU_BACKUP_AGE_RECIPIENT=age1…   (needs `age`)\n' +
				'    AINU_BACKUP_GPG_RECIPIENT=<keyid>  (needs `gpg`)\n' +
				'    AINU_BACKUP_PASSPHRASE=<pass>      (needs `gpg`, symmetric)'
		);
	}
} catch (err) {
	// Encryption failed — the plaintext dump is already safely out of repo.
	console.warn(`⚠ Encryption step failed (${(err as Error).message}); kept plaintext ${out}`);
	finalPath = out;
	restore = `turso db shell <new> < ${out}`;
}

const mb = (dump.length / 1e6).toFixed(1);
const lines = dump.split('\n').length;
console.log(`✓ Backup → ${finalPath}  (${mb} MB, ${lines} lines)`);
console.log(`  Restore: turso db create <new>; ${restore}`);
