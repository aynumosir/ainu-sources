#!/usr/bin/env bun
// Point-in-time backup of the live libSQL/Turso DB → a timestamped, RESTORABLE
// SQL dump — produced entirely through the @libsql/client, with NO dependency
// on the `turso` CLI.
//
// WHY (vs scripts/backup-db.ts): backup-db.ts shells out to `turso db shell …
// .dump`, which needs a logged-in Turso *account* (CLI auth). That auth expires
// and then backups silently fail. This script needs only a DB *token* — the
// exact credential the Worker and CI already hold (DATABASE_URL +
// DATABASE_AUTH_TOKEN) — so it keeps working when the CLI does not. It also
// works unchanged against a local `file:` SQLite, which is how it is tested.
//
// SECURITY: the dump includes Better-Auth tables (emails, sessions, OAuth
// tokens, password hashes). Same posture as backup-db.ts — written OUT OF THE
// REPO by default, encrypted at rest when configured, FAILS CLOSED (no
// plaintext left on disk) when encryption is requested but cannot complete.
//
// Connection (libSQL client; works for both file: and remote libsql://):
//   DATABASE_URL=<file:… | libsql://…>   required
//   DATABASE_AUTH_TOKEN=<token>          required for remote, ignored for file:
//
// Destination (first match wins):
//   AINU_BACKUP_DIR=<path>     explicit out-of-repo directory
//   ALLOW_IN_REPO_BACKUP=1     legacy scripts/data/backups (gitignored)
//   else                       ~/.ainu-sources/backups
// Writing inside the repo workspace is refused unless ALLOW_IN_REPO_BACKUP=1.
//
// Encryption at rest (first match wins). FAILS CLOSED: if any of these is set
// but the tool is missing or the encrypt step errors, the backup ABORTS and no
// plaintext dump is left on disk:
//   AINU_BACKUP_AGE_RECIPIENT=<age1…>   age -r  → *.sql.age
//   AINU_BACKUP_GPG_RECIPIENT=<keyid>   gpg -e  → *.sql.gpg
//   AINU_BACKUP_PASSPHRASE=<pass>       gpg -c  → *.sql.gpg (symmetric)
//   else                                plaintext *.sql + loud warning
//
// Timestamp: AINU_BACKUP_TS=<str> overrides; else derived from new Date().
//
// Restore (see scripts/restore-libsql.ts, or the one-liners below):
//   local : sqlite3 fresh.db < prod-libsql-<ts>.sql
//   local : bun scripts/restore-libsql.ts --db file:/tmp/fresh.db --file prod-libsql-<ts>.sql
//   remote: turso db shell <db>          < prod-libsql-<ts>.sql
//   enc.  : gpg -d prod-libsql-<ts>.sql.gpg | sqlite3 fresh.db
//
// Run: bun run backup:libsql
import { createClient, type Client } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, chmodSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Connection: libSQL client only (no turso CLI) ---------------------------
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('✗ DATABASE_URL is not set. Pass file:/path/to/db.sqlite or libsql://host.');
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but DATABASE_AUTH_TOKEN is not set.');
	process.exit(1);
}

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

const ts =
	process.env.AINU_BACKUP_TS ??
	new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
const out = path.join(dir, `prod-libsql-${ts}.sql`);

// --- Fail-closed cleanup ------------------------------------------------------
// Never leave a plaintext dump of Better-Auth secrets on disk when something
// goes wrong (encryption requested-but-unavailable, a DB read error mid-stream,
// a failed sanity check, …). Delete the plaintext dump and any partial
// encrypted output, then abort nonzero.
function bail(reason: string): never {
	for (const p of [out, `${out}.age`, `${out}.gpg`]) {
		try {
			if (existsSync(p)) unlinkSync(p);
		} catch {
			/* best-effort cleanup */
		}
	}
	console.error(`✗ Backup aborted (no plaintext left on disk):\n    ${reason}`);
	process.exit(1);
}

// --- SQLite literal escaping (correct, lossless round-trip) -------------------
// Matches the semantics of sqlite3 `.dump`:
//   NULL                → NULL
//   integer / bigint    → as-is (bigint kept exact, never via float)
//   real                → as-is (non-finite → NULL, since SQLite can't store it as a literal)
//   text                → '…'  with single-quotes doubled
//   BLOB                → X'<hex>'   (ArrayBuffer / typed array / Buffer)
function lit(v: unknown): string {
	if (v === null || v === undefined) return 'NULL';
	if (typeof v === 'bigint') return v.toString();
	if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
	if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
	if (v instanceof ArrayBuffer) return `X'${Buffer.from(v).toString('hex')}'`;
	if (ArrayBuffer.isView(v)) {
		const view = v as ArrayBufferView;
		return `X'${Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('hex')}'`;
	}
	// Defensive fallback: anything unexpected is serialised as text.
	return `'${String(v).replace(/'/g, "''")}'`;
}

async function main() {
	// intMode 'bigint' keeps INTEGER columns exact (no float rounding for large
	// values); lit() serialises bigint without quotes so the round-trip is lossless.
	const client: Client = createClient({
		url,
		authToken: authToken || undefined,
		intMode: 'bigint'
	});

	console.log(`Dumping ${url.split('?')[0]} via @libsql/client (no turso CLI)…`);

	// Stream straight to disk so a 5800-source DB with 60k+ ledger rows never has
	// to be held in memory all at once. mode 0o600 from creation; chmod to be sure.
	const ws = createWriteStream(out, { mode: 0o600 });
	let bytes = 0;
	let lines = 0;
	const write = (s: string) =>
		new Promise<void>((resolve, reject) => {
			bytes += Buffer.byteLength(s);
			lines += (s.match(/\n/g) ?? []).length;
			ws.write(s, (err) => (err ? reject(err) : resolve()));
		});

	let sawCreateTable = false;
	let sawSourcesInsert = false;

	try {
		await write(
			`-- ainu-sources libSQL backup\n` +
				`-- generated ${new Date().toISOString()} from ${url.split('?')[0]}\n` +
				`PRAGMA foreign_keys=OFF;\n` +
				`BEGIN TRANSACTION;\n`
		);

		// Real tables only — skip SQLite internals, libSQL internals, Litestream.
		const tablesRs = await client.execute(
			`SELECT name, sql FROM sqlite_master
			 WHERE type='table'
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE 'libsql_%'
			   AND name NOT LIKE '\\_litestream%' ESCAPE '\\'
			 ORDER BY rowid`
		);

		const BATCH = 1000;
		for (const t of tablesRs.rows) {
			const name = String(t.name);
			const createSql = t.sql == null ? null : String(t.sql);
			if (createSql) {
				await write(`${createSql};\n`);
				sawCreateTable = true;
			}

			// Row count drives the batch loop; we never SELECT * the whole table.
			const cnt = await client.execute(`SELECT count(*) AS n FROM "${name}"`);
			const total = Number(cnt.rows[0].n);

			for (let offset = 0; offset < total; offset += BATCH) {
				// Implicit table-scan order (rowid order for ordinary rowid tables) is
				// stable for an unchanging DB, so LIMIT/OFFSET paging is consistent.
				// A backup is a point-in-time snapshot; if the DB is being written
				// concurrently the usual snapshot caveat applies.
				const rs = await client.execute({
					sql: `SELECT * FROM "${name}" LIMIT ? OFFSET ?`,
					args: [BATCH, offset]
				});
				const ncols = rs.columns.length;
				let chunk = '';
				for (const row of rs.rows) {
					const arr = row as unknown as ArrayLike<unknown>;
					const vals: string[] = [];
					for (let i = 0; i < ncols; i++) vals.push(lit(arr[i]));
					chunk += `INSERT INTO "${name}" VALUES(${vals.join(',')});\n`;
				}
				if (chunk) await write(chunk);
				if (name === 'sources' && total > 0) sawSourcesInsert = true;
			}
		}

		// Indexes / triggers / views, AFTER all data. Auto-created indexes (those
		// backing PRIMARY KEY / UNIQUE constraints) have sql=NULL and are rebuilt by
		// CREATE TABLE — skip them; emit only user/explicit DDL.
		const ddlRs = await client.execute(
			`SELECT sql FROM sqlite_master
			 WHERE type IN ('index','trigger','view')
			   AND sql IS NOT NULL
			   AND name NOT LIKE 'sqlite_%'
			   AND name NOT LIKE 'libsql_%'
			   AND name NOT LIKE '\\_litestream%' ESCAPE '\\'
			 ORDER BY rowid`
		);
		for (const r of ddlRs.rows) await write(`${String(r.sql)};\n`);

		await write(`COMMIT;\nPRAGMA foreign_keys=ON;\n`);
	} catch (err) {
		await new Promise<void>((resolve) => ws.end(resolve));
		bail(`DB read / write failed mid-dump: ${(err as Error).message}`);
	}

	// Flush + close the stream before reading/encrypting the file.
	await new Promise<void>((resolve, reject) => ws.end((err?: Error | null) => (err ? reject(err) : resolve())));
	chmodSync(out, 0o600);

	// Sanity-check before trusting it as a backup — never keep a truncated/empty
	// dump (same intent as backup-db.ts: must have schema + the sources data).
	if (!sawCreateTable || !sawSourcesInsert) {
		bail(
			`Dump looks empty or invalid (sawCreateTable=${sawCreateTable}, ` +
				`sawSourcesInsert=${sawSourcesInsert}) — refusing to keep it.`
		);
	}

	// --- At-rest encryption: FAIL CLOSED when requested but unavailable --------
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
	const encryptionRequested = !!(ageRcpt || gpgRcpt || passphrase);

	let finalPath = out;
	let restore = `sqlite3 <new.db> < "${out}"   # or: turso db shell <db> < "${out}"`;
	if (!encryptionRequested) {
		console.warn(
			'⚠ Backup is UNENCRYPTED. It contains Better-Auth secrets (emails, sessions,\n' +
				'  OAuth tokens, password hashes). Configure one of:\n' +
				'    AINU_BACKUP_AGE_RECIPIENT=age1…   (needs `age`)\n' +
				'    AINU_BACKUP_GPG_RECIPIENT=<keyid>  (needs `gpg`)\n' +
				'    AINU_BACKUP_PASSPHRASE=<pass>      (needs `gpg`, symmetric)'
		);
	} else {
		// Only encryption runs in this try, so any throw means the requested
		// encryption failed → bail (delete plaintext + partial, exit 1).
		try {
			if (ageRcpt) {
				if (!has('age')) bail('AINU_BACKUP_AGE_RECIPIENT set but `age` is not installed');
				finalPath = `${out}.age`;
				execFileSync('age', ['-r', ageRcpt, '-o', finalPath, out]);
				chmodSync(finalPath, 0o600);
				unlinkSync(out);
				restore = `age -d -i <identity> "${finalPath}" | sqlite3 <new.db>`;
			} else if (gpgRcpt) {
				if (!has('gpg')) bail('AINU_BACKUP_GPG_RECIPIENT set but `gpg` is not installed');
				finalPath = `${out}.gpg`;
				execFileSync('gpg', [
					'--batch', '--yes', '--trust-model', 'always',
					'--encrypt', '--recipient', gpgRcpt, '--output', finalPath, out
				]);
				chmodSync(finalPath, 0o600);
				unlinkSync(out);
				restore = `gpg -d "${finalPath}" | sqlite3 <new.db>`;
			} else if (passphrase) {
				if (!has('gpg')) bail('AINU_BACKUP_PASSPHRASE set but `gpg` is not installed');
				finalPath = `${out}.gpg`;
				execFileSync(
					'gpg',
					['--batch', '--yes', '--pinentry-mode', 'loopback', '--passphrase-fd', '0', '-c', '--output', finalPath, out],
					{ input: passphrase }
				);
				chmodSync(finalPath, 0o600);
				unlinkSync(out);
				restore = `gpg -d "${finalPath}" | sqlite3 <new.db>`;
			}
		} catch (err) {
			bail((err as Error).message);
		}
	}

	const mb = (statSync(finalPath).size / 1e6).toFixed(1);
	console.log(`✓ Backup → ${finalPath}  (${mb} MB, ${lines} lines)`);
	console.log(`  Restore: ${restore}`);
}

main().catch((err) => bail((err as Error).message));
