/**
 * merge-persons: TSV parsing, the name policy, and the merge itself on a real
 * in-memory schema.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { parseMergeTsv, pickName, pickNameEn, runMerges } from './merge-persons';
import { resolvePersonSlug } from '../src/lib/server/resolve-slug';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

const HEADER = 'keep_slug\tmerge_slug\tnew_slug\tnote';
const tsv = (...rows: string[]) => [HEADER, ...rows].join('\n');
const quiet = { log: () => {} };

describe('parseMergeTsv', () => {
	it('reads rows and treats an empty new_slug as no rename', () => {
		const p = parseMergeTsv(tsv('keep-a\tp-1\t\tnote', 'p-2\tp-3\tnew-b\t'));
		expect(p.errors).toEqual([]);
		expect(p.rows).toEqual([
			{ line: 2, keepSlug: 'keep-a', mergeSlug: 'p-1', newSlug: null },
			{ line: 3, keepSlug: 'p-2', mergeSlug: 'p-3', newSlug: 'new-b' }
		]);
	});

	it('accepts an existing one-character slug', () => {
		expect(parseMergeTsv(tsv('john-c-maher\tc\t\t')).errors).toEqual([]);
	});

	it('rejects a short or wrong header', () => {
		expect(parseMergeTsv('a\tb\nx\ty').errors[0]).toMatch(/bad header/);
		expect(parseMergeTsv('keep_slug\tmerge_slug\tnote\na\tb\tx').errors[0]).toMatch(/bad header/);
	});

	it('reads a rename-only row and rejects a row with neither merge nor rename', () => {
		const p = parseMergeTsv(tsv('p-i37yiv\t\taraida-seino\t', 'p-1\t\t\t'));
		expect(p.rows).toEqual([{ line: 2, keepSlug: 'p-i37yiv', mergeSlug: '', newSlug: 'araida-seino' }]);
		expect(p.errors).toHaveLength(1);
	});

	it('rejects a self-merge, a repeated merge, a non-slug and a repeated new_slug', () => {
		const p = parseMergeTsv(
			tsv(
				'aa\taa\t\t',
				'aa\tbb\t\t',
				'cc\tbb\t\t',
				'dd\tee\tBad Slug\t',
				'ff\tgg\tnew\t',
				'hh\tii\tnew\t',
				'Bad\tjj\t\t'
			)
		);
		expect(p.errors).toHaveLength(5);
		expect(p.rows.map((r) => r.mergeSlug)).toEqual(['bb', 'gg']);
	});
});

describe('name policy', () => {
	it('prefers the Japanese display name over a romanisation', () => {
		expect(pickName('Genzō Sarashina', '更科 源蔵')).toBe('更科 源蔵');
		expect(pickName('更科 源蔵', 'Genzō Sarashina')).toBe('更科 源蔵');
	});
	it('prefers the modern character form when both are Japanese', () => {
		expect(pickName('金澤 庄三郎', '金沢 庄三郎')).toBe('金沢 庄三郎');
		expect(pickName('金沢 庄三郎', '金澤 庄三郎')).toBe('金沢 庄三郎');
		expect(pickName('北原 モコットゥナㇱ', '北原次郎太')).toBe('北原 モコットゥナㇱ');
	});
	it('keeps the macrons on a romanised name and fills a missing one', () => {
		expect(pickNameEn('Hirofumi Kato', 'Hirofumi Katō')).toBe('Hirofumi Katō');
		expect(pickNameEn('Kanazawa Shōzaburō', 'Shōzaburō Kanazawa')).toBe('Kanazawa Shōzaburō');
		expect(pickNameEn(null, 'Wada Bunjiro')).toBe('Wada Bunjiro');
	});
});

async function makeDb(): Promise<Db> {
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

let db: Db;
beforeEach(async () => {
	db = await makeDb();
});

async function person(
	slug: string,
	extra: Partial<typeof schema.persons.$inferInsert> = {}
): Promise<string> {
	const [row] = await db
		.insert(schema.persons)
		.values({ slug, name: `Name ${slug}`, ...extra })
		.returning({ id: schema.persons.id });
	return row.id;
}

async function source(slug: string): Promise<string> {
	const [row] = await db
		.insert(schema.sources)
		.values({ slug, title: `Title ${slug}`, type: 'dictionary' })
		.returning({ id: schema.sources.id });
	return row.id;
}

async function join(sourceId: string, personId: string, role: string) {
	await db.insert(schema.sourcePersons).values({ sourceId, personId, role });
}

const row = async (id: string) =>
	(await db.select().from(schema.persons).where(eq(schema.persons.id, id)))[0];

const joinsOf = async (personId: string) =>
	(
		await db
			.select({ sourceId: schema.sourcePersons.sourceId, role: schema.sourcePersons.role })
			.from(schema.sourcePersons)
			.where(eq(schema.sourcePersons.personId, personId))
	).sort((a, b) => a.role.localeCompare(b.role));

describe('runMerges', () => {
	it('plan mode decides but writes nothing', async () => {
		const keep = await person('shozaburo-kanazawa');
		const merge = await person('p-1oqavzn', { wikidata: 'Q11647465' });
		const stats = await runMerges(db, parseMergeTsv(tsv('shozaburo-kanazawa\tp-1oqavzn\t\t')).rows, {
			apply: false,
			...quiet
		});
		expect(stats.applied).toBe(1);
		expect((await row(merge)).status).toBe('active');
		expect((await row(keep)).status).toBe('active');
		expect(await db.select().from(schema.personSlugRedirects)).toEqual([]);
	});

	it('apply moves joins, drops the doubled ones, sets names and gaps, redirects and soft-merges', async () => {
		const keep = await person('shozaburo-kanazawa', {
			name: '金澤 庄三郎',
			nameEn: 'Kanazawa Shōzaburō'
		});
		const merge = await person('p-1oqavzn', {
			name: '金沢 庄三郎',
			nameEn: 'Shōzaburō Kanazawa',
			wikidata: 'Q11647465',
			birthYear: 1872
		});
		const s1 = await source('s-1');
		const s2 = await source('s-2');
		await join(s1, keep, 'author');
		await join(s1, merge, 'author');
		await join(s2, merge, 'editor');

		const stats = await runMerges(db, parseMergeTsv(tsv('shozaburo-kanazawa\tp-1oqavzn\t\t')).rows, {
			apply: true,
			...quiet
		});
		expect(stats.applied).toBe(1);

		expect(await joinsOf(keep)).toEqual([
			{ sourceId: s1, role: 'author' },
			{ sourceId: s2, role: 'editor' }
		]);
		expect(await joinsOf(merge)).toEqual([]);
		const kept = await row(keep);
		expect(kept.name).toBe('金沢 庄三郎');
		expect(kept.nameEn).toBe('Kanazawa Shōzaburō');
		expect(kept.wikidata).toBe('Q11647465');
		expect(kept.birthYear).toBe(1872);
		const merged = await row(merge);
		expect(merged.status).toBe('merged');
		expect(merged.mergedIntoPersonId).toBe(keep);
		expect(merged.name).toBe('金沢 庄三郎');
		const redirects = await db.select().from(schema.personSlugRedirects);
		expect(redirects.map((r) => [r.oldSlug, r.personId])).toEqual([['p-1oqavzn', keep]]);
		expect(await resolvePersonSlug(db, 'p-1oqavzn')).toBe('shozaburo-kanazawa');
	});

	it('takes the Japanese name from the merged row when the kept row is romanised', async () => {
		const keep = await person('genzo-sarashina', {
			name: 'Genzō Sarashina',
			nameEn: 'Genzō Sarashina'
		});
		await person('p-14h09wv', { name: '更科 源蔵', nameEn: 'Genzō Sarashina' });
		await runMerges(db, parseMergeTsv(tsv('genzo-sarashina\tp-14h09wv\t\t')).rows, {
			apply: true,
			...quiet
		});
		expect((await row(keep)).name).toBe('更科 源蔵');
	});

	it('renames the kept person when new_slug is given, redirects both old slugs, and reruns clean', async () => {
		const keep = await person('p-1cm34pn');
		await person('p-14dam0m');
		const rows = parseMergeTsv(tsv('p-1cm34pn\tp-14dam0m\tota-ryu\t')).rows;
		await runMerges(db, rows, { apply: true, ...quiet });
		expect((await row(keep)).slug).toBe('ota-ryu');
		const redirects = (await db.select().from(schema.personSlugRedirects))
			.map((r) => r.oldSlug)
			.sort();
		expect(redirects).toEqual(['p-14dam0m', 'p-1cm34pn']);
		expect(await resolvePersonSlug(db, 'p-1cm34pn')).toBe('ota-ryu');

		const again = await runMerges(db, rows, { apply: true, ...quiet });
		expect(again.alreadyApplied).toBe(1);
		expect(again.missing).toBe(0);
	});

	it('renames a person without a merge partner, once', async () => {
		const id = await person('p-i37yiv', { name: '新井田 セイノ' });
		const rows = parseMergeTsv(tsv('p-i37yiv\t\taraida-seino\t')).rows;
		const first = await runMerges(db, rows, { apply: true, ...quiet });
		expect(first.applied).toBe(1);
		expect((await row(id)).slug).toBe('araida-seino');
		expect(await resolvePersonSlug(db, 'p-i37yiv')).toBe('araida-seino');
		const again = await runMerges(db, rows, { apply: true, ...quiet });
		expect(again.alreadyApplied).toBe(1);
	});

	it('carries the redirects a merged person already owned over to the kept person', async () => {
		const keep = await person('a-keep');
		const mid = await person('b-mid');
		await person('c-old');
		await runMerges(db, parseMergeTsv(tsv('b-mid\tc-old\t\t')).rows, { apply: true, ...quiet });
		await runMerges(db, parseMergeTsv(tsv('a-keep\tb-mid\t\t')).rows, { apply: true, ...quiet });
		const redirects = (await db.select().from(schema.personSlugRedirects))
			.map((r) => [r.oldSlug, r.personId])
			.sort();
		expect(redirects).toEqual([
			['b-mid', keep],
			['c-old', keep]
		]);
		expect((await row(mid)).mergedIntoPersonId).toBe(keep);
		expect(await resolvePersonSlug(db, 'c-old')).toBe('a-keep');
		expect(await resolvePersonSlug(db, 'b-mid')).toBe('a-keep');
	});

	it('refuses conflicting Wikidata items and a taken new_slug', async () => {
		await person('a-keep', { wikidata: 'Q1' });
		await person('b-merge', { wikidata: 'Q2' });
		const conflict = await runMerges(db, parseMergeTsv(tsv('a-keep\tb-merge\t\t')).rows, {
			apply: true,
			...quiet
		});
		expect(conflict.refused).toBe(1);
		const untouched = await db.select().from(schema.persons).where(eq(schema.persons.slug, 'b-merge'));
		expect(untouched[0].status).toBe('active');

		await person('c-merge');
		await person('taken');
		const taken = await runMerges(db, parseMergeTsv(tsv('a-keep\tc-merge\ttaken\t')).rows, {
			apply: true,
			...quiet
		});
		expect(taken.refused).toBe(1);
	});
});
