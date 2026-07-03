/**
 * apply-reslug — TSV parser/validator unit tests + the full plan/apply flow on
 * an isolated libSQL in-memory database built from the real drizzle migrations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import { parseReslugTsv, runReslug, SLUG_RE } from './apply-reslug';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

const HEADER = 'old_slug\tnew_slug\ttitle\tauthor\tflags';
const tsv = (...rows: string[]) => [HEADER, ...rows].join('\n');

// ---------------------------------------------------------------------------
// parseReslugTsv
// ---------------------------------------------------------------------------

describe('parseReslugTsv', () => {
	it('keeps only rows with a non-empty new_slug', () => {
		const p = parseReslugTsv(
			tsv('a-1\tnew-a\tT\tA\t', 'b-2\t\tT\tA\tunsure', 'c-3\tnew-c\tT\tA\t')
		);
		expect(p.errors).toEqual([]);
		expect(p.rows.map((r) => [r.oldSlug, r.newSlug])).toEqual([
			['a-1', 'new-a'],
			['c-3', 'new-c']
		]);
		expect(p.emptyNew).toBe(1);
	});

	it('rejects a wrong header and reports it', () => {
		const p = parseReslugTsv('slug\tnew\nfoo\tbar');
		expect(p.rows).toEqual([]);
		expect(p.errors).toHaveLength(1);
		expect(p.errors[0]).toMatch(/bad header/);
	});

	it('tolerates CRLF, blank lines, and rows without trailing columns', () => {
		const p = parseReslugTsv(`${HEADER}\r\na-1\tnew-a\r\n\r\n`);
		expect(p.errors).toEqual([]);
		expect(p.rows).toEqual([{ line: 2, oldSlug: 'a-1', newSlug: 'new-a' }]);
	});

	it('flags duplicate old_slug and duplicate new_slug within the file', () => {
		const p = parseReslugTsv(tsv('a-1\tnew-a', 'a-1\tnew-b', 'c-3\tnew-a'));
		expect(p.rows).toHaveLength(1);
		expect(p.errors).toHaveLength(2);
		expect(p.errors[0]).toMatch(/duplicate old_slug/);
		expect(p.errors[1]).toMatch(/duplicate new_slug/);
	});
});

describe('SLUG_RE', () => {
	it('accepts the target charset and length', () => {
		expect(SLUG_RE.test('1875-dobrotvorsky-ainu-russian-dictionary')).toBe(true);
		expect(SLUG_RE.test('a1')).toBe(true);
		expect(SLUG_RE.test('a'.repeat(60))).toBe(true);
	});
	it('rejects garbage', () => {
		for (const bad of ['a', 'a'.repeat(61), '-leading', 'UPPER-case', 'has space', 'jp日本語', ''])
			expect(SLUG_RE.test(bad)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runReslug on a real (in-memory) schema
// ---------------------------------------------------------------------------

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

async function seedSource(slug: string): Promise<string> {
	const [row] = await db
		.insert(schema.sources)
		.values({ slug, title: `Title of ${slug}`, type: 'dictionary' })
		.returning({ id: schema.sources.id });
	return row.id;
}

const slugOf = async (id: string) =>
	(await db.select({ slug: schema.sources.slug }).from(schema.sources).where(eq(schema.sources.id, id)))[0]
		?.slug;

const quiet = { log: () => {} };

describe('runReslug', () => {
	it('plan mode decides but writes nothing', async () => {
		const id = await seedSource('1792-x-14odq2e');
		const { rows } = parseReslugTsv(tsv('1792-x-14odq2e\t1792-moninkarukuru-uwepeker'));
		const stats = await runReslug(db, rows, { apply: false, ...quiet });
		expect(stats.applied).toBe(1); // would apply
		expect(await slugOf(id)).toBe('1792-x-14odq2e');
		expect(await db.select().from(schema.slugRedirects)).toEqual([]);
		expect(await db.select().from(schema.sourceRevisions)).toEqual([]);
	});

	it('apply mode renames, records the redirect, and writes one revision', async () => {
		const id = await seedSource('1792-x-14odq2e');
		const { rows } = parseReslugTsv(tsv('1792-x-14odq2e\t1792-moninkarukuru-uwepeker'));
		const stats = await runReslug(db, rows, { apply: true, ...quiet });
		expect(stats.applied).toBe(1);

		expect(await slugOf(id)).toBe('1792-moninkarukuru-uwepeker');

		const redirects = await db.select().from(schema.slugRedirects);
		expect(redirects).toHaveLength(1);
		expect(redirects[0].oldSlug).toBe('1792-x-14odq2e');
		expect(redirects[0].sourceId).toBe(id);

		const revs = await db.select().from(schema.sourceRevisions);
		expect(revs).toHaveLength(1);
		expect(revs[0].sourceId).toBe(id);
		expect(revs[0].action).toBe('update');
		expect(revs[0].summary).toBe(
			'slug renamed: 1792-x-14odq2e → 1792-moninkarukuru-uwepeker (re-slug 2026-07)'
		);
		// snapshot carries the POST-rename state, merge-write.ts shape
		const snap = revs[0].snapshot as { source: { slug: string }; links: unknown[]; tags: string[] };
		expect(snap.source.slug).toBe('1792-moninkarukuru-uwepeker');
		expect(snap.links).toEqual([]);
		expect(snap.tags).toEqual([]);
	});

	it('is idempotent: a rerun skips already-applied rows without new writes', async () => {
		await seedSource('1792-x-14odq2e');
		const { rows } = parseReslugTsv(tsv('1792-x-14odq2e\t1792-moninkarukuru-uwepeker'));
		await runReslug(db, rows, { apply: true, ...quiet });
		const again = await runReslug(db, rows, { apply: true, ...quiet });
		expect(again.applied).toBe(0);
		expect(again.alreadyApplied).toBe(1);
		expect(await db.select().from(schema.slugRedirects)).toHaveLength(1);
		expect(await db.select().from(schema.sourceRevisions)).toHaveLength(1);
	});

	it('skips a chain with a warning: old_slug that is already a redirect elsewhere', async () => {
		await seedSource('current-slug');
		const first = parseReslugTsv(tsv('current-slug\trenamed-once')).rows;
		await runReslug(db, first, { apply: true, ...quiet });
		// proposal now tries to re-rename the RETIRED slug to something else
		const second = parseReslugTsv(tsv('current-slug\trenamed-twice')).rows;
		const stats = await runReslug(db, second, { apply: true, ...quiet });
		expect(stats.chains).toBe(1);
		expect(stats.applied).toBe(0);
	});

	it('refuses collisions with live slugs and retired slugs, and bad patterns', async () => {
		await seedSource('victim-1');
		await seedSource('victim-2');
		await seedSource('victim-3');
		await seedSource('taken-slug');
		await runReslug(db, parseReslugTsv(tsv('victim-3\tvictim-3-renamed')).rows, {
			apply: true,
			...quiet
		});

		const { rows } = parseReslugTsv(
			tsv(
				'victim-1\ttaken-slug', // live collision
				'victim-2\tvictim-3', // retired collision (victim-3 is now a redirect)
				'victim-3-renamed\tBad_Slug!' // charset violation
			)
		);
		const stats = await runReslug(db, rows, { apply: true, ...quiet });
		expect(stats.refused).toBe(3);
		expect(stats.applied).toBe(0);
	});

	it('counts old_slugs that match no source as missing', async () => {
		const { rows } = parseReslugTsv(tsv('never-existed\tnew-slug'));
		const stats = await runReslug(db, rows, { apply: true, ...quiet });
		expect(stats.missing).toBe(1);
		expect(await db.select().from(schema.slugRedirects)).toEqual([]);
	});
});
