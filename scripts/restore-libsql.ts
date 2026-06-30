#!/usr/bin/env bun
// Restore a dump produced by scripts/backup-libsql.ts into a libSQL/Turso DB —
// through the @libsql/client, with NO dependency on the `turso` CLI.
//
// It reads the .sql file and hands the whole script to the libSQL engine via
// `executeMultiple`, so statement boundaries are parsed by SQLite itself — a
// naive split on `;` would break on semicolons inside text literals (notes,
// summaries, JSON), so we never do that.
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
// For a very large dump, the plain CLI path streams better:
//   sqlite3 fresh.db < dump.sql          # local
//   turso db shell <db> < dump.sql       # remote
import { createClient, type Client } from '@libsql/client';
import { readFileSync } from 'node:fs';

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

	console.log(`Restoring ${file} → ${url!.split('?')[0]} via @libsql/client…`);
	// executeMultiple runs the whole script; SQLite parses statement boundaries,
	// so semicolons inside text literals are handled correctly.
	await client.executeMultiple(sql);

	const after = await client.execute(`SELECT count(*) AS n FROM "sources"`);
	console.log(`✓ Restore complete. sources rows = ${after.rows[0].n}`);
}

main().catch((err) => {
	console.error('✗ restore-libsql failed:', (err as Error).message);
	process.exit(1);
});
