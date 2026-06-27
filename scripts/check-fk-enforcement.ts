#!/usr/bin/env bun
/**
 * Deploy gate: verify foreign-key integrity of the live DB.
 *
 * READ-ONLY. Never writes. Safe to run against production.
 *
 *   1. Reports the connection's live `PRAGMA foreign_keys` value. NOTE: on the
 *      remote Turso HTTP client this reflects only the ephemeral stream this
 *      check opens — the Worker app cannot hold a session PRAGMA (see
 *      src/lib/server/db/index.ts). Informational, not a guarantee.
 *   2. Runs `PRAGMA foreign_key_check` — the real durability check. Lists every
 *      existing row whose foreign key points at a missing parent, regardless of
 *      whether enforcement is currently on. Latent orphans that enabling FK
 *      enforcement would start rejecting show up here.
 *
 * Exits NONZERO if any violation exists, so CI/deploy can block on it.
 *
 * Run: bun scripts/check-fk-enforcement.ts   (reads DATABASE_URL / DATABASE_AUTH_TOKEN from env)
 */
import { createClient } from '@libsql/client';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const isFile = url.startsWith('file:');
if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });

// 1. Report live enforcement state (informational).
const fk = await client.execute('PRAGMA foreign_keys');
const fkRow = fk.rows[0] as Record<string, unknown> | undefined;
const fkVal = Number(fkRow?.foreign_keys ?? fkRow?.[0] ?? 0);
console.log(`PRAGMA foreign_keys = ${fkVal} (${fkVal ? 'ENFORCED' : 'NOT enforced'} on this connection)`);
if (!fkVal) {
	console.warn(
		'! foreign_keys is OFF on this connection. On the stateless Turso HTTP client this is\n' +
			'  expected per-stream; live enforcement depends on the server default. Informational only.'
	);
}

// 2. The real gate: existing FK violations (read-only).
const check = await client.execute('PRAGMA foreign_key_check');
if (check.rows.length === 0) {
	console.log('OK PRAGMA foreign_key_check: no foreign-key violations.');
	process.exit(0);
}

console.error(`FAIL PRAGMA foreign_key_check found ${check.rows.length} violation(s):`);
for (const row of check.rows) {
	const r = row as Record<string, unknown>;
	const table = r.table ?? r[0];
	const rowid = r.rowid ?? r[1];
	const parent = r.parent ?? r[2];
	const fkid = r.fkid ?? r[3];
	console.error(`  - table=${table} rowid=${rowid} -> missing parent in "${parent}" (fk #${fkid})`);
}
console.error('\nEnabling FK enforcement would start rejecting writes that touch these rows.');
console.error('Fix the orphans (delete or re-point the child rows) before relying on enforcement.');
process.exit(1);
