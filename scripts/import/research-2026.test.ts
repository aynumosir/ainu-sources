import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { sources, sourceLinks, sourceIdentifiers, sourceObservations, sourcePersons, persons } from '../../src/lib/server/db/schema';
import { mergeSourceObservation, type Db } from '../../src/lib/server/merge';
import { run, type RecordEntry } from './research-2026';

const client = createClient({ url: 'file::memory:' });
const db = drizzle(client) as Db;
beforeAll(async () => {
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
});
afterAll(() => client.close());

const entry: RecordEntry = {
	slug: 'research-example', title: 'Research example', existing: true,
	fields: { title: 'Research example', type: 'article', summary: 'Reviewed summary', notes: 'Published in 2026.', languages: ['eng'] },
	corrections: { type: { from: 'book', to: 'article' }, summary: { from: 'Journal name', to: 'Reviewed summary' } },
	identifiers: [{ kind: 'doi', value: '10.1234/example' }],
	links: [{ type: 'doi', label: 'Publisher', url: 'https://doi.org/10.1234/example' }]
};

it('previews without writes, applies reviewed corrections, and replays without changing records or duplicating evidence', async () => {
	await db.insert(sources).values({ id: 'reviewed', slug: entry.slug, title: entry.title,
		type: 'book', summary: 'Journal name', languages: ['ain'] });
	const before = await db.select().from(sources);
	await run(db, [entry]);
	expect(await db.select().from(sources)).toEqual(before);
	expect(await db.select().from(sourceObservations)).toHaveLength(0);
	await run(db, [entry], true);
	const first = await db.select().from(sources);
	expect(first[0].summary).toBe('Reviewed summary');
	expect(first[0].type).toBe('article');
	expect(first[0].languages).toEqual(['ain', 'eng']);
	const observations = await db.select().from(sourceObservations);
	const links = await db.select().from(sourceLinks);
	await run(db, [entry], true);
	expect(await db.select().from(sources)).toEqual(first);
	expect(await db.select().from(sourceObservations)).toEqual(observations);
	expect(await db.select().from(sourceLinks)).toEqual(links);
});

it('rejects a DOI owned by another source before writing any batch member', async () => {
	const before = await db.select().from(sources);
	await expect(run(db, [
		{ ...entry, slug: 'new-before-collision', existing: false, corrections: undefined, identifiers: [], fields: { title: 'New work', type: 'article' } },
		{ ...entry, slug: 'new-with-collision', existing: false, corrections: undefined,
			identifiers: [{ kind: 'doi', value: 'HTTPS://DOI.ORG/10.1234/EXAMPLE' }] }
	], true)).rejects.toThrow('Identifier ownership needs review');
	expect(await db.select().from(sources)).toEqual(before);
	expect((await db.select().from(sourceIdentifiers)).filter((id) => id.kind === 'doi')).toHaveLength(1);
});

it('rejects duplicate normalized identifiers inside a new batch before writing', async () => {
	const before = await db.select().from(sources);
	await expect(run(db, ['first-new', 'second-new'].map((slug) => ({
		...entry, slug, existing: false, corrections: undefined,
		fields: { title: slug, type: 'article' }, identifiers: [{ kind: 'doi', value: '10.1234/new' }]
	})), true)).rejects.toThrow('Duplicate batch identifier');
	expect(await db.select().from(sources)).toEqual(before);
});

it('stops if a reviewed correction has drifted to an unexpected value', async () => {
	await expect(run(db, [{ ...entry, corrections: { type: { from: 'thesis', to: 'book' } } }], true))
		.rejects.toThrow('Correction needs review');
});

it('rejects unsuccessful earlier observations, including corrections, on retry', async () => {
	const observations = await db.select().from(sourceObservations);
	for (const observation of observations) {
		await db.update(sourceObservations).set({ status: 'partial' }).where(eq(sourceObservations.id, observation.id));
		await expect(run(db, [entry], true)).rejects.toThrow(/Earlier (observation|correction) needs review/);
		await db.update(sourceObservations).set({ status: observation.status }).where(eq(sourceObservations.id, observation.id));
	}
});

it('rejects an invalid enum in preflight before any member of the batch is written', async () => {
	const before = await db.select().from(sources);
	await expect(run(db, [
		{ ...entry, slug: 'valid-before-invalid', existing: false, corrections: undefined, identifiers: [], fields: { title: 'Valid work', type: 'article' } },
		{ ...entry, slug: 'invalid-certainty', existing: false, corrections: undefined, identifiers: [], fields: { title: 'Uncertain work', yearCertainty: 'approx' } }
	], true)).rejects.toThrow('Preflight needs review');
	expect(await db.select().from(sources)).toEqual(before);
});

it('uses the current canonical author when replaying a new record after an editorial change', async () => {
	const record: RecordEntry = { ...entry, slug: 'new-author-work', title: 'Author work', existing: false,
		corrections: undefined, identifiers: [], links: [], fields: { title: 'Author work', author: 'Anna Bugaeva', type: 'article' } };
	await run(db, [record], true);
	const [source] = await db.select().from(sources).where(eq(sources.slug, record.slug));
	await mergeSourceObservation(db, { origin: 'manual', originRecordId: 'author-correction',
		derivation: 'editorial_decision', confidence: 1, targetSourceId: source.id,
		fields: { author: 'Éva Dékány' } });
	await db.delete(sourcePersons).where(eq(sourcePersons.sourceId, source.id));
	await run(db, [record], true);
	const authors = await db.select({ name: persons.name }).from(sourcePersons)
		.innerJoin(persons, eq(persons.id, sourcePersons.personId)).where(eq(sourcePersons.sourceId, source.id));
	expect(authors).toHaveLength(1);
	expect(authors[0].name).toContain('Dékány');
});
