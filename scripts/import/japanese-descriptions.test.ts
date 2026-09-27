import { beforeEach, afterEach, expect, it } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { mergeSourceObservation, type Db } from '../../src/lib/server/merge';
import { run, type JapaneseDescription } from './japanese-descriptions';
import manifest from '../data/japanese-descriptions.json';

let client: Client;
let db: Db;
const entry: JapaneseDescription = {
	slug: 'dictionary', title: '辞典', expectedSummary: 'An Ainu dictionary.', summaryJa: 'アイヌ語辞典。'
};

beforeEach(async () => {
	client = createClient({ url: ':memory:' });
	db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
	await db.insert(schema.sources).values({ id: 'one', slug: entry.slug, title: entry.title, type: 'dictionary', summary: entry.expectedSummary });
});
afterEach(() => client.close());

it('previews without writes, records provenance on apply, and is idempotent', async () => {
	expect(await run(db, { entries: [entry] })).toEqual({ total: 1, pending: 1, unchanged: 0, applied: 0 });
	expect(await db.select().from(schema.sourceObservations)).toHaveLength(0);
	expect((await db.select().from(schema.sources))[0].summaryJa).toBeNull();
	expect((await run(db, { entries: [entry], apply: true })).applied).toBe(1);
	const [source] = await db.select().from(schema.sources);
	expect(source).toMatchObject({ id: 'one', summary: entry.expectedSummary, summaryJa: entry.summaryJa });
	expect(await db.select().from(schema.sources)).toHaveLength(1);
	expect(await db.select().from(schema.sourceRevisions)).toHaveLength(1);
	expect((await db.select().from(schema.sourceFieldProvenance))[0]).toMatchObject({ fieldName: 'summaryJa', origin: 'japanese-descriptions' });
	expect(await run(db, { entries: [entry], apply: true })).toEqual({ total: 1, pending: 0, unchanged: 1, applied: 0 });
	expect(await db.select().from(schema.sourceRevisions)).toHaveLength(1);
});

it.each([
	{ title: '別の辞典' },
	{ summary: 'A revised description.' },
	{ summaryJa: '編集者の概要。' },
	{ status: 'hidden' }
])('aborts before writing any entries when a later record has drifted: %j', async (change) => {
	const second = { ...entry, slug: 'second', title: '第二辞典' };
	await db.insert(schema.sources).values({ id: 'two', slug: second.slug, title: second.title, type: 'dictionary', summary: second.expectedSummary, ...change });
	await expect(run(db, { entries: [entry, second], apply: true })).rejects.toThrow();
	expect((await db.select().from(schema.sources).where(eq(schema.sources.id, 'one')))[0].summaryJa).toBeNull();
	expect(await db.select().from(schema.sourceObservations)).toHaveLength(0);
});

it('rejects duplicate or missing identities', async () => {
	await expect(run(db, { entries: [entry, entry], apply: true })).rejects.toThrow('Duplicate source');
	await expect(run(db, { entries: [entry, { ...entry, slug: 'missing' }], apply: true })).rejects.toThrow('Source identity changed');
	expect(await db.select().from(schema.sourceObservations)).toHaveLength(0);
});

it('applies the full reviewed manifest without changing source identities or original descriptions', async () => {
	await db.insert(schema.sources).values(manifest.map((item) => ({
		slug: item.slug, title: item.title, type: 'book', summary: item.expectedSummary
	})));
	expect((await run(db, { apply: true })).applied).toBe(manifest.length);
	const rows = await db.select().from(schema.sources);
	for (const item of manifest) {
		expect(rows.find((row) => row.slug === item.slug)).toMatchObject({ summary: item.expectedSummary, summaryJa: item.summaryJa });
	}
	expect(rows).toHaveLength(manifest.length + 1);
	expect((await run(db, { apply: true })).applied).toBe(0);
});


it('preflights editorial deletion claims before applying any translation', async () => {
	const second = { ...entry, slug: 'second', title: '第二辞典' };
	await db.insert(schema.sources).values({ id: 'two', slug: second.slug, title: second.title, type: 'dictionary', summary: second.expectedSummary });
	const editorial = { origin: 'manual', originRecordId: 'editorial-second', targetSourceId: 'two', derivation: 'editorial_decision', confidence: 1 };
	await mergeSourceObservation(db, { ...editorial, fields: { summaryJa: '削除前の概要。' } });
	await mergeSourceObservation(db, { ...editorial, explicitDeletes: ['summaryJa'] });
	const observationsBefore = await db.select().from(schema.sourceObservations);
	await expect(run(db, { entries: [entry, second] })).rejects.toThrow('blocked by merge');
	await expect(run(db, { entries: [entry, second], apply: true })).rejects.toThrow('blocked by merge');
	expect((await db.select().from(schema.sources)).every((row) => row.summaryJa === null)).toBe(true);
	expect(await db.select().from(schema.sourceObservations)).toEqual(observationsBefore);
});
