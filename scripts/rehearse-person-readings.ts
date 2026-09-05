#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../src/lib/server/db/schema';
import { run } from './import/person-readings';
import readings from './data/person-readings.json';

if (!process.argv[2]) throw new Error('Usage: bun scripts/rehearse-person-readings.ts snapshot.json [expected.json]');
const snapshot = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'reading-rehearsal-'));
const client = createClient({ url: `file:${join(scratch, 'test.db')}` });
try {
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
	for (const table of ['persons', 'sources', 'source_observation_runs', 'source_observations', 'source_persons', 'person_slug_redirects']) {
		const rows = snapshot[table] as Record<string, never>[];
		if (table === 'persons') rows.sort((a, b) => Number(a.status === 'merged') - Number(b.status === 'merged'));
		for (let offset = 0; offset < rows.length; offset += 100) {
			await client.batch(rows.slice(offset, offset + 100).map(row => ({
				sql: `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, args: Object.values(row)
			})), 'write');
		}
	}
	const before = await db.select().from(schema.persons);
	const plan = await run(db, { dryRun: true });
	if (plan.other || plan.applied !== readings.length) throw new Error('Incomplete reading plan');
	if (JSON.stringify(await db.select().from(schema.persons)) !== JSON.stringify(before)) throw new Error('Dry run changed data');
	const applied = await run(db);
	const again = await run(db);
	if (again.applied || again.other) throw new Error('Reading import is not idempotent');
	const after = await db.select().from(schema.persons);
	for (const row of before) {
		const correction = readings.find(e => e.slugs.includes(row.slug))?.corrected ?? {};
		if (JSON.stringify(after.find(p => p.id === row.id)) !== JSON.stringify({ ...row, ...correction }))
			throw new Error(`Unexpected person change: ${row.slug}`);
	}
	const expected: Record<string, unknown> = {};
	for (const table of ['persons', 'source_persons', 'person_slug_redirects']) {
		expected[table] = (await client.execute(`SELECT * FROM ${table}`)).rows;
		if (table !== 'persons') {
			const key = table === 'person_slug_redirects' ? 'old_slug' : 'id';
			const actual = new Map((expected[table] as Record<string, unknown>[]).map(r => [r[key], r]));
			if (actual.size !== snapshot[table].length || snapshot[table].some((r: Record<string, unknown>) => Object.keys(r).some(k => actual.get(r[key])?.[k] !== r[k])))
				throw new Error(`Changed relationships: ${table}`);
		}
	}
	if ((await client.execute('PRAGMA foreign_key_check')).rows.length) throw new Error('Foreign-key violation');
	if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(expected), { mode: 0o600 });
	console.log(JSON.stringify({ applied, repeatChanges: again.applied, foreignKeyErrors: 0, relationshipsPreserved: true }));
} finally { client.close(); rmSync(scratch, { recursive: true, force: true }); }
