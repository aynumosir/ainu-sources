import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { sources, sourceLinks } from '../../src/lib/server/db/schema';
import type { Db } from '../../src/lib/server/merge';
import { run, type RecordEntry } from './historical-iiif';
import records from '../data/historical-iiif.json';

const client = createClient({ url: 'file::memory:' });
const db = drizzle(client) as Db;
beforeAll(async () => {
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
});
afterAll(() => client.close());

const entry: RecordEntry = {
	slug: '1888-example-folktales', title: 'Example folktales', existing: true,
	corrections: { type: { from: 'article', to: 'book' } },
	fields: { summary: 'Curated description', languages: ['eng'] },
	materials: [{ label: 'Library copy', manifest: 'https://archive.org/example/manifest.json', description: 'Facsimile' }],
	links: [{ type: 'iiif', label: 'Library copy', url: 'https://archive.org/example/manifest.json' }]
};

it('previews without writing, preserves editorial text, unions languages, and replays without duplication', async () => {
	await db.insert(sources).values({ id: 'original', slug: entry.slug, title: entry.title,
		type: 'article', summary: 'Editorial description', languages: ['ain'] });
	const before = await db.select().from(sources);
	await run(db, [entry]);
	expect(await db.select().from(sources)).toEqual(before);
	expect(await db.select().from(sourceLinks)).toHaveLength(0);
	await run(db, [entry], true);
	const first = await db.select().from(sources);
	expect(first[0].summary).toBe('Editorial description');
	expect(first[0].type).toBe('book');
	expect(first[0].languages).toEqual(expect.arrayContaining(['ain', 'eng']));
	const links = await db.select().from(sourceLinks);
	expect(links).toHaveLength(1);
	await run(db, [entry], true);
	expect(await db.select().from(sources)).toEqual(first);
	expect(await db.select().from(sourceLinks)).toEqual(links);
});

it('rejects an incomplete batch before writing any of its new sources', async () => {
	const before = await db.select().from(sources);
	await expect(run(db, [
		{ ...entry, slug: 'new-facsimile-record', existing: false, corrections: undefined, fields: { title: 'New facsimile', type: 'book' } },
		{ ...entry, slug: 'missing-reviewed-source' }
	], true)).rejects.toThrow('Missing reviewed source');
	expect(await db.select().from(sources)).toEqual(before);
});

it('covers all 26 Honkoku materials and 47 distinct facsimiles without literal Unicode escapes', () => {
	const materials = records.flatMap((record) => record.materials);
	expect(materials.filter((material) => 'honkokuEntryId' in material)).toHaveLength(26);
	expect(new Set(materials.map((material) => material.manifest)).size).toBe(47);
	expect(new Set(records.map((record) => record.slug)).size).toBe(records.length);
	for (const material of materials) {
		expect(material.label).not.toContain(String.fromCharCode(92) + 'u3000');
	}
});
