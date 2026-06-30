#!/usr/bin/env bun
// Restore a dump produced by scripts/backup-libsql.ts into a libSQL/Turso DB —
// through the @libsql/client, with NO dependency on the `turso` CLI.
//
// It splits the .sql file into statements with a STRING-AWARE scanner (a `;` only
// ends a statement when it is NOT inside a '…' literal — so semicolons inside
// notes / summaries / JSON payloads never split a statement) and replays the
// CREATE/INSERT statements through the libSQL client in chunked write batches.
// `client.executeMultiple` (one giant `db.exec`) is correct but pathologically
// slow on a real prod-size dump (minutes for ~178k statements vs seconds here),
// so we do not use it.
//
// FOREIGN KEYS: the dump is emitted in sqlite_master order (drizzle creates
// tables alphabetically, so child tables like source_links precede sources), so
// it MUST be replayed with foreign_keys OFF. We set that on the connection before
// replaying; the dump's own BEGIN/COMMIT/PRAGMA lines are skipped (a batch is
// already one transaction, and PRAGMA foreign_keys is a no-op inside one).
//
// SAFETY: this is a WRITE operation. It deliberately does NOT fall back to the
// DATABASE_URL env var — you must pass --db EXPLICITLY so a stray prod env can
// never be the silent target. It refuses to restore into a non-empty DB unless
// --force is given.
//
// Args:
//   --db <url>      REQUIRED. file:/path/to/new.db  or  libsql://host
//   --file <path>   REQUIRED. the .sql dump (decrypt first if it is .gpg/.age)
//   --token <t>     auth token for a remote --db (or DATABASE_AUTH_TOKEN env)
//   --force         allow restoring into a DB that already has tables
//
// Examples:
//   bun scripts/restore-libsql.ts --db file:/tmp/fresh.db --file prod-libsql-<ts>.sql
//   gpg -d prod-libsql-<ts>.sql.gpg > /tmp/d.sql && \
//     bun scripts/restore-libsql.ts --db file:/tmp/fresh.db --file /tmp/d.sql
//
// Equivalent CLI paths (no client needed) for a fresh local/remote DB:
//   sqlite3 fresh.db < dump.sql          # local
//   turso db shell <db> < dump.sql       # remote (needs the turso CLI)
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';

// Split a SQL dump into statements. A `;` only ends a statement when it is NOT
// inside a '…' literal; SQLite escapes a quote inside a literal by doubling it
// (''), and BLOB literals X'…' use the same single-quote delimiters, so the same
// rule covers them. `--` to end-of-line comments (outside literals) are skipped.
function* statements(sql: string): Generator<string> {
	const n = sql.length;
	let i = 0;
	let start = 0;
	while (i < n) {
		const c = sql[i];
		if (c === "'") {
			i++;
			while (i < n) {
				if (sql[i] === "'") {
					if (sql[i + 1] === "'") {
						i += 2; // escaped quote inside the literal
						continue;
					}
					i++; // closing quote
					break;
				}
				i++;
			}
			continue;
		}
		if (c === '-' && sql[i + 1] === '-') {
			while (i < n && sql[i] !== '\n') i++; // line comment to EOL
			continue;
		}
		if (c === ';') {
			const stmt = sql.slice(start, i).trim();
			if (stmt) yield stmt;
			i++;
			start = i;
			continue;
		}
		i++;
	}
	const tail = sql.slice(start).trim();
	if (tail) yield tail;
}

// First SQL keyword of a statement, ignoring leading whitespace and `--` comment
// lines (the dump's header comments bundle in front of the first PRAGMA). Used to
// drop the transaction-control / pragma lines that must not go inside a batch.
function firstKeyword(stmt: string): string {
	let s = stmt;
	for (;;) {
		s = s.replace(/^\s+/, '');
		if (s.startsWith('--')) {
			const nl = s.indexOf('\n');
			if (nl === -1) return '';
			s = s.slice(nl + 1);
			continue;
		}
		break;
	}
	return s.slice(0, 16).toUpperCase();
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag);

const url = argValue('--db');
const file = argValue('--file');
if (!url || !file) {
	console.error(
		'✗ Usage: bun scripts/restore-libsql.ts --db <file:…|libsql://…> --file <dump.sql> [--token <t>] [--force]\n' +
			'  --db is REQUIRED and never read from env (so prod can never be the silent target).'
	);
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote --db given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}

async function main() {
	const sql = readFileSync(file!, 'utf8');
	if (!sql.includes('CREATE TABLE') || !/INSERT INTO ["']?sources/.test(sql)) {
		console.error('✗ File does not look like an ainu-sources dump (no schema / no sources INSERTs).');
		process.exit(1);
	}

	const client: Client = createClient({ url: url!, authToken: authToken || undefined });

	// Guard against clobbering an existing DB unless --force.
	const existing = await client.execute(
		`SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%'`
	);
	if (Number(existing.rows[0].n) > 0 && !hasFlag('--force')) {
		console.error(
			`✗ Target DB already has ${existing.rows[0].n} table(s). Refusing to restore over it.\n` +
				`  Use a fresh DB, or pass --force to proceed anyway.`
		);
		process.exit(1);
	}

	// Collect the replayable statements (CREATE/INSERT), skipping the dump's own
	// transaction-control + pragma lines — a batch is already one transaction.
	const stmts: string[] = [];
	for (const s of statements(sql)) {
		const kw = firstKeyword(s);
		if (
			kw === '' ||
			kw.startsWith('BEGIN') ||
			kw.startsWith('COMMIT') ||
			kw.startsWith('END') ||
			kw.startsWith('PRAGMA')
		) {
			continue;
		}
		stmts.push(s);
	}

	console.log(
		`Restoring ${file} → ${url!.split('?')[0]} via @libsql/client (${stmts.length} statements, no turso CLI)…`
	);

	// Replay with foreign keys OFF: the dump is in sqlite_master order, so child
	// tables/rows can precede their parents. Set it on the connection first (a
	// PRAGMA is a no-op inside the per-batch transaction).
	await client.execute('PRAGMA foreign_keys=OFF');
	const CHUNK = 1000;
	for (let i = 0; i < stmts.length; i += CHUNK) {
		// Each batch is one write transaction. Restore targets a fresh DB (guarded
		// above), so a mid-restore failure just means: start over with a fresh DB.
		await client.batch(stmts.slice(i, i + CHUNK), 'write');
	}

	const after = await client.execute(`SELECT count(*) AS n FROM "sources"`);
	console.log(`✓ Restore complete. sources rows = ${after.rows[0].n}`);
}

main().catch((err) => {
	console.error('✗ restore-libsql failed:', (err as Error).message);
	process.exit(1);
});
