import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as schema from '../../src/lib/server/db/schema';
import { run, type PersonReading } from './person-readings';
import manifest from '../data/person-readings.json';

it('applies the sourced manifest idempotently while preserving identities, dates and links', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'reading-test-'));
	const client = createClient({ url: `file:${join(scratch, 'test.db')}` });
	try {
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
		await db.insert(schema.persons).values(manifest.map(e => ({
			id: e.slugs[0], slug: e.slugs[0], name: e.name, birthYear: 1900, ...e.expected
		})));
		await db.insert(schema.persons).values({ id: 'namesake', slug: 'namesake', name: manifest[0].name });
		await db.insert(schema.sources).values({ id: 'book', slug: 'book', title: 'Book', type: 'book' });
		await db.insert(schema.sourcePersons).values({ id: 'link', sourceId: 'book', personId: manifest[0].slugs[0], role: 'editor', confidence: 0.8 });
		const before = await db.select().from(schema.persons);
		const links = await db.select().from(schema.sourcePersons);
		expect((await run(db, { dryRun: true })).applied).toBe(manifest.length);
		expect(await db.select().from(schema.persons)).toEqual(before);
		expect((await run(db, { plan: true })).applied).toBe(manifest.length);
		expect(await db.select().from(schema.persons)).toEqual(before);
		// A conflict late in the plan must prevent all preceding updates.
		const last = manifest.at(-1)!;
		await db.update(schema.persons).set({ nameKana: '別の確認済みの読み' }).where(eq(schema.persons.slug, last.slugs[0]));
		const drifted = await db.select().from(schema.persons);
		await expect(run(db)).rejects.toThrow('needs rechecking');
		expect(await db.select().from(schema.persons)).toEqual(drifted);
		await db.update(schema.persons).set({ nameKana: last.expected.nameKana }).where(eq(schema.persons.slug, last.slugs[0]));
		expect((await run(db)).applied).toBe(manifest.length);
		const after = await db.select().from(schema.persons);
		for (const row of before) {
			const correction = manifest.find(e => e.slugs.includes(row.slug))?.corrected ?? {};
			expect(after.find(p => p.id === row.id)).toEqual({ ...row, ...correction });
		}
		expect(await db.select().from(schema.sourcePersons)).toEqual(links);
		expect((await run(db)).applied).toBe(0);
		expect(await db.select().from(schema.persons)).toEqual(after);
		await db.update(schema.persons).set({ name: '別人' }).where(eq(schema.persons.slug, last.slugs[0]));
		await expect(run(db)).rejects.toThrow('identity changed');
	} finally { client.close(); rmSync(scratch, { recursive: true, force: true }); }
});

it('rejects unsupported fields, duplicate decisions, merged targets and missing evidence', async () => {
	const scratch = mkdtempSync(join(tmpdir(), 'reading-guards-'));
	const client = createClient({ url: `file:${join(scratch, 'test.db')}` });
	try {
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
		const entry: PersonReading = { slugs: ['a'], name: '名', expected: { nameKana: null }, corrected: { nameKana: 'な' }, sources: ['https://example.org/author'], checkedAt: '2026-09-05', note: 'Author profile' };
		await db.insert(schema.persons).values({ id: 'a', slug: 'a', name: '名' });
		await expect(run(db, {}, [{ ...entry, corrected: { birthYear: 1900 } }])).rejects.toThrow('Invalid reading field');
		await expect(run(db, {}, [entry, entry])).rejects.toThrow('Duplicate reading');
		await expect(run(db, {}, [{ ...entry, sources: [] }])).rejects.toThrow('Missing reading evidence');
		await db.insert(schema.persons).values({ id: 'b', slug: 'b', name: '名' });
		await db.update(schema.persons).set({ status: 'merged', mergedIntoPersonId: 'b' }).where(eq(schema.persons.id, 'a'));
		await expect(run(db, {}, [entry])).rejects.toThrow('target merged');
		expect((await run(db, {}, [{ ...entry, slugs: ['absent'] }])).detail?.missing).toEqual(['absent']);
	} finally { client.close(); rmSync(scratch, { recursive: true, force: true }); }
});
