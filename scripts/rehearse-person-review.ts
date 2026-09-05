#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from '../src/lib/server/db/schema';
import { run } from './import/person-enrichment';
import { parseMergeTsv, runMerges } from './merge-persons';
import { applyAttributions } from './apply-person-attributions';
import attributionReview from './data/person-attribution-review.json';

const input = process.argv[2];
if (!input) throw new Error('Usage: bun scripts/rehearse-person-review.ts snapshot.json [output.json]');
const snapshot = JSON.parse(readFileSync(input, 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'person-review-'));
const client = createClient({ url: `file:${join(scratch, 'rehearsal.db')}` });
const db = drizzle(client, { schema });
await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
for (const table of ['persons', 'sources', 'source_observation_runs', 'source_observations', 'source_persons', 'person_slug_redirects']) {
	const rows = table === 'persons'
		? [...snapshot[table]].sort((a: { status: string }, b: { status: string }) => Number(a.status === 'merged') - Number(b.status === 'merged'))
		: table === 'sources' ? snapshot[table].map((row: Record<string, unknown>) => ({ created_at: 0, updated_at: 0, ...row })) : snapshot[table];
	for (let start = 0; start < rows.length; start += 100) {
		await client.batch(rows.slice(start, start + 100).map((row: Record<string, never>) => ({
			sql: `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`,
			args: Object.values(row)
		})), 'write');
	}
}
const parsed = parseMergeTsv(readFileSync(new URL('./data/person-review-merges.tsv', import.meta.url), 'utf8'));
if (parsed.errors.length) throw new Error(parsed.errors.join('\n'));
const enrichment = await run(db);
const attributions = await applyAttributions(db);
const merges = await runMerges(db, parsed.rows, { apply: true });
if (merges.missing || merges.refused) throw new Error('Merge rehearsal refused an operation');
const again = await run(db);
const attributionsAgain = await applyAttributions(db);
const mergeAgain = await runMerges(db, parsed.rows, { apply: true, log: () => {} });
if (again.applied || mergeAgain.applied || mergeAgain.missing || mergeAgain.refused || Object.values(attributionsAgain).some(Boolean)) throw new Error('Not idempotent');
const after: Record<string, unknown> = {};
for (const table of ['persons', 'sources', 'source_persons', 'person_slug_redirects']) after[table] = (await client.execute(`SELECT * FROM ${table}`)).rows;
const orphaned = await client.execute("SELECT count(*) AS n FROM source_persons sp JOIN persons p ON p.id=sp.person_id WHERE p.status='merged'");
if (Number(orphaned.rows[0].n)) throw new Error('References remain on merged people');
const fk = await client.execute('PRAGMA foreign_key_check');
if (fk.rows.length) throw new Error('Foreign-key violation');
const people = await db.select().from(schema.persons);
const byId = new Map(people.map(p => [p.id, p]));
const bySlug = new Map(people.map(p => [p.slug, p]));
const canonical = (id: string): string => {
	const seen = new Set<string>();
	while (byId.get(id)?.status === 'merged') {
		if (seen.has(id)) throw new Error('Merge cycle');
		seen.add(id);
		id = byId.get(id)!.mergedIntoPersonId!;
	}
	if (!byId.has(id)) throw new Error('Missing merge destination');
	return id;
};
const expectedLinks = new Set<string>();
for (const link of snapshot.source_persons) {
	const change = attributionReview.changes.find(c => c.id === link.id);
	if (change && !change.toSlug) continue;
	const personId = change ? bySlug.get(change.toSlug!)!.id : link.person_id;
	expectedLinks.add(JSON.stringify([link.source_id, canonical(personId), change && 'toRole' in change ? change.toRole : link.role]));
}
for (const addition of attributionReview.additions)
	expectedLinks.add(JSON.stringify([addition.sourceId, canonical(bySlug.get(addition.personSlug)!.id), addition.role]));
const actualLinks = new Set((await db.select().from(schema.sourcePersons)).map(l => JSON.stringify([l.sourceId, l.personId, l.role])));
if (expectedLinks.size !== actualLinks.size || [...expectedLinks].some(l => !actualLinks.has(l)))
	throw new Error('Unexpected source/person/role changes');
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(after), { mode: 0o600 });
console.log(JSON.stringify({ enrichment: enrichment.applied, attributions, merges: merges.applied, repeatChanges: again.applied + mergeAgain.applied, foreignKeyErrors: fk.rows.length }));
client.close();
rmSync(scratch, { recursive: true, force: true });
