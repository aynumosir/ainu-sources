import { afterAll, beforeAll, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { persons } from '../../src/lib/server/db/schema';
import obituaries from '../data/person-obituaries.json';
import corrections from '../data/person-identity-corrections.json';
import reviews from '../data/person-review.json';
import { run } from './person-enrichment';

const client = createClient({ url: 'file::memory:' });
const db = drizzle(client);
beforeAll(async () => {
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
});
afterAll(() => client.close());

it('fills reviewed deaths offline, preserves existing dates, and is idempotent', async () => {
	await db.insert(persons).values(obituaries.map((entry) => ({
		id: entry.slug, slug: entry.slug, name: entry.name,
		...reviews.find((review) => review.slugs.includes(entry.slug))?.expected
	})));
	const before = await db.select().from(persons);
	const plan = await run(db, { dryRun: true });
	expect(plan.applied).toBe(obituaries.length);
	expect(await db.select().from(persons)).toEqual(before);

	// A stored date and a mismatched identity must survive the import.
	await db.update(persons).set({ deathYear: 1999 }).where(eq(persons.slug, 'kan-wada'));
	await db.update(persons).set({ name: 'Unrelated person' }).where(eq(persons.slug, 'p-1vg5icr'));
	await db.insert(persons).values({ id: 'namesake', slug: 'namesake', name: '津曲 敏郎' });
	const first = await run(db);
	expect(first.applied).toBe(obituaries.length - 1); // Wada also receives a reviewed birth year.
	const rows = await db.select().from(persons);
	for (const entry of obituaries) {
		const expected = entry.slug === 'kan-wada' ? 1999
			: entry.slug === 'p-1vg5icr' ? null : entry.deathYear;
		expect(rows.find((row) => row.slug === entry.slug)?.deathYear).toBe(expected);
	}
	expect(rows.find((row) => row.slug === 'namesake')?.deathYear).toBeNull();
	expect((await run(db)).applied).toBe(0);
	expect(await db.select().from(persons)).toEqual(rows);
});

it('corrects reviewed namesakes, suppresses stale caches, and rejects unexpected states before writing', async () => {
	await db.delete(persons);
	await db.insert(persons).values(corrections.map((entry) => ({
		id: entry.slug, slug: entry.slug, name: entry.name, ...entry.expected
	})));
	const before = await db.select().from(persons);
	expect((await run(db, { dryRun: true })).applied).toBe(corrections.length);
	expect(await db.select().from(persons)).toEqual(before);
	await db.update(persons).set({ deathYear: 2026 }).where(eq(persons.slug, 'uchida-minoru'));
	const unexpected = await db.select().from(persons);
	await expect(run(db)).rejects.toThrow('Identity correction needs review: uchida-minoru');
	expect(await db.select().from(persons)).toEqual(unexpected);
	await db.update(persons).set({ deathYear: 1945 }).where(eq(persons.slug, 'uchida-minoru'));
	expect((await run(db)).applied).toBe(corrections.length);
	for (const entry of corrections) {
		const [row] = await db.select().from(persons).where(eq(persons.slug, entry.slug));
		expect(row).toMatchObject(entry.corrected);
	}
	expect((await run(db)).applied).toBe(0);
	await db.update(persons).set({ name: 'Unrelated namesake' }).where(eq(persons.slug, 'murasaki'));
	await expect(run(db)).rejects.toThrow('Identity correction needs review: murasaki');
});

it('applies the complete birth/name review without reviving namesake identities', async () => {
	await db.delete(persons);
	await db.insert(persons).values(reviews.map((entry) => ({
		id: entry.slugs[0], slug: entry.slugs[0], name: entry.name, ...entry.expected
	})));
	const before = await db.select().from(persons);
	await run(db, { dryRun: true });
	expect(await db.select().from(persons)).toEqual(before);
	await run(db);
	for (const entry of reviews) {
		const [row] = await db.select().from(persons).where(eq(persons.slug, entry.slugs[0]));
		expect(row).toMatchObject(entry.corrected);
	}
	expect((await run(db)).applied).toBe(0);
	await db.update(persons).set({ birthYear: 2000 }).where(eq(persons.slug, 'kenji-araki'));
	const unexpected = await db.select().from(persons);
	await expect(run(db)).rejects.toThrow('Person review needs rechecking: kenji-araki.birthYear');
	expect(await db.select().from(persons)).toEqual(unexpected);
});
