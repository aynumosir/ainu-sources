/**
 * Status-aware read-model tests (Phase 5, plan §4).
 *
 * Runs every PUBLIC read against a REAL libSQL database (built by applying the
 * drizzle migrations to a throwaway file DB) seeded with sources in each
 * lifecycle status — active, a merged loser pointing at an active winner, hidden,
 * soft_deleted, candidate — plus relations in each status (accepted / candidate).
 *
 * Two things are proven:
 *   1. LEAK-PROOF: list / search / stats / timeline / map / network / sitemap /
 *      detail / person+place+institution+tag reads surface ONLY active sources and
 *      ONLY accepted relations; a merged slug 302-redirects to its winner; hidden /
 *      candidate / soft_deleted slugs are not-found (→ 404 at the route).
 *   2. NO-OP on all-active data: flipping the very same fixture so every row is
 *      active/accepted makes the previously-hidden rows reappear in EXACTLY the
 *      counts you'd expect — the predicate filters by status and nothing else.
 *
 * The app's singleton `db` (queries.ts / network.ts both import it) is pointed at
 * the file DB via the `$env/dynamic/private` test stub, so the production query
 * code is exercised unmodified — no dependency injection, no mocks.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { env } from '$env/dynamic/private';
import * as schema from './db/schema';
import * as queries from './queries';
import { sourceSitemapShards } from './sitemap-manifest';
import { getCitationNetwork } from './network';
import { db } from './db';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));
const DB_PATH = join(tmpdir(), `ainu-visibility-${process.pid}.db`);

// Point the app singleton (`src/lib/server/db`) at the throwaway file BEFORE any
// query runs — it connects lazily on first use, so setting this in beforeAll is
// enough. Migration runs on a separate raw client on the same file (DDL is shared
// across connections); all data is seeded + read through the singleton `db`.
beforeAll(async () => {
	for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) if (existsSync(f)) rmSync(f);
	env.DATABASE_URL = `file:${DB_PATH}`;
	const migClient = createClient({ url: `file:${DB_PATH}` });
	await migrate(drizzle(migClient, { schema }), { migrationsFolder: MIGRATIONS });
	migClient.close();
});

// `db` / `queries` / `network` all import the singleton, which connects lazily on
// first use (inside beforeEach, after env.DATABASE_URL is set) — so static imports
// here never trigger a connection before the env is wired.

// --- fixture ---------------------------------------------------------------
// One source per lifecycle status + a second active source, wired with links,
// tags, persons, places, institutions and relations. `allActive` rewrites every
// status to active/accepted so the SAME graph drives the no-op assertions.
type Src = { id: string; slug: string; title: string; category: string; type: string; yearStart: number; status: string; mergedIntoSourceId?: string | null };
const SOURCES: Src[] = [
	{ id: 'w', slug: 'winner', title: 'Winner Work', category: 'primary', type: 'book', yearStart: 1900, status: 'active' },
	{ id: 'l', slug: 'loser', title: 'Loser Work', category: 'primary', type: 'book', yearStart: 1901, status: 'merged', mergedIntoSourceId: 'w' },
	{ id: 'h', slug: 'hidden-src', title: 'Hidden Work', category: 'primary', type: 'book', yearStart: 1902, status: 'hidden' },
	{ id: 'd', slug: 'deleted-src', title: 'Deleted Work', category: 'primary', type: 'book', yearStart: 1903, status: 'soft_deleted' },
	{ id: 'c', slug: 'cand-xyz-candidate', title: 'Candidate Work', category: 'primary', type: 'book', yearStart: 1904, status: 'candidate' },
	{ id: 'a2', slug: 'active-two', title: 'Active Two', category: 'secondary', type: 'article', yearStart: 1905, status: 'active' }
];
// fromId, toId, type, status
const RELATIONS: [string, string, string, string][] = [
	['w', 'a2', 'cites', 'accepted'], // both active → always visible
	['w', 'h', 'cites', 'accepted'], // endpoint hidden → hidden unless all-active
	['w', 'c', 'cites', 'candidate'], // candidate relation → hidden unless all-active
	['l', 'a2', 'cites', 'accepted'] // from merged loser → hidden unless all-active
];

async function wipe() {
	// Child rows first; null the self-FK before deleting sources (both
	// merged_into_source_id and source_revisions.source_id are ON DELETE restrict).
	await db.delete(schema.sourceRelations);
	await db.delete(schema.sourceLinks);
	await db.delete(schema.sourceTags);
	await db.delete(schema.sourcePersons);
	await db.delete(schema.sourcePlaces);
	await db.delete(schema.sourceInstitutions);
	await db.delete(schema.sourceRevisions);
	await db.update(schema.sources).set({ mergedIntoSourceId: null });
	await db.delete(schema.sources);
	await db.delete(schema.persons);
	await db.delete(schema.places);
	await db.delete(schema.institutions);
	await db.delete(schema.tags);
}

async function seed(allActive = false) {
	await wipe();
	const sStatus = (s: string) => (allActive ? 'active' : s);
	const rStatus = (s: string) => (allActive ? 'accepted' : s);

	await db.insert(schema.sources).values(
		SOURCES.map((s) => ({
			id: s.id,
			slug: s.slug,
			title: s.title,
			category: s.category,
			type: s.type,
			yearStart: s.yearStart,
			status: sStatus(s.status),
			mergedIntoSourceId: s.mergedIntoSourceId ?? null
		}))
	);
	await db.insert(schema.sourceRelations).values(
		RELATIONS.map(([f, t, type, st]) => ({ fromSourceId: f, toSourceId: t, type, status: rStatus(st) }))
	);

	// W (active) and H (hidden) each get a digital link, a tag, a person, a place
	// and an institution — so every directory count / detail list can prove it
	// counts the active one and never the hidden one.
	await db.insert(schema.sourceLinks).values([
		{ sourceId: 'w', type: 'pdf', url: 'https://example.org/w.pdf' },
		{ sourceId: 'h', type: 'pdf', url: 'https://example.org/h.pdf' },
		{ sourceId: 'l', type: 'pdf', url: 'https://example.org/l.pdf' }
	]);
	await db.insert(schema.tags).values([{ id: 't1', slug: 'topic-one', name: 'Topic One', category: 'topic' }]);
	await db.insert(schema.sourceTags).values([
		{ sourceId: 'w', tagId: 't1' },
		{ sourceId: 'h', tagId: 't1' }
	]);
	await db.insert(schema.persons).values([
		{ id: 'p1', slug: 'p1', name: 'Person One' },
		{ id: 'p2', slug: 'p2', name: 'Person Two', status: sStatus('merged') }
	]);
	await db.insert(schema.sourcePersons).values([
		{ sourceId: 'w', personId: 'p1', role: 'author' },
		{ sourceId: 'h', personId: 'p1', role: 'author' }
	]);
	await db.insert(schema.places).values([
		{ id: 'pl1', slug: 'pl1', name: 'Place One', lat: 43.06, lng: 141.35 },
		{ id: 'pl2', slug: 'pl2', name: 'Place Two', status: sStatus('hidden') }
	]);
	await db.insert(schema.sourcePlaces).values([
		{ sourceId: 'w', placeId: 'pl1', role: 'dialect' },
		{ sourceId: 'h', placeId: 'pl1', role: 'dialect' }
	]);
	await db.insert(schema.institutions).values([
		{ id: 'i1', slug: 'i1', name: 'Institution One' },
		{ id: 'i2', slug: 'i2', name: 'Institution Two', status: sStatus('hidden') }
	]);
	await db.insert(schema.sourceInstitutions).values([
		{ sourceId: 'w', institutionId: 'i1', role: 'holding' },
		{ sourceId: 'h', institutionId: 'i1', role: 'holding' }
	]);
}

const NON_ACTIVE_SLUGS = ['loser', 'hidden-src', 'deleted-src', 'cand-xyz-candidate'];

async function allSitemapSources() {
	const shards = await Promise.all(sourceSitemapShards.map((shard) => queries.getSitemapSources(shard)));
	return shards.flat();
}

async function explain(sql: string): Promise<string[]> {
	const client = createClient({ url: `file:${DB_PATH}` });
	try {
		const plan = await client.execute(`EXPLAIN QUERY PLAN ${sql}`);
		return plan.rows.map((row) => String(row.detail));
	} finally {
		client.close();
	}
}

const sourceSitemapPlans = sourceSitemapShards.map((shard) => {
	const conditions = ["status = 'active'"];
	if (shard.start !== undefined) conditions.push(`slug >= '${shard.start}'`);
	if (shard.end !== undefined) conditions.push(`slug < '${shard.end}'`);
	return {
		sql: `SELECT slug, updated_at FROM sources WHERE ${conditions.join(' AND ')} ORDER BY slug LIMIT 2001`,
		index: 'sources_sitemap_idx'
	};
});

function assertCoveringPlan(details: string[], index: string) {
	expect(details.join('\n')).toContain(`USING COVERING INDEX ${index}`);
	expect(details.some((detail) => detail.includes('USE TEMP B-TREE'))).toBe(false);
	expect(details.some((detail) => detail.startsWith('SCAN '))).toBe(false);
}

// ===========================================================================
// 1. Mixed-status fixture: non-active rows must never surface.
// ===========================================================================
describe('status-aware reads — only active sources / accepted relations leak through', () => {
	beforeEach(async () => seed(false));

	it('listSources returns ONLY the two active sources', async () => {
		const { items, total } = await queries.listSources({});
		expect(total).toBe(2);
		expect(items.map((s) => s.slug).sort()).toEqual(['active-two', 'winner']);
		for (const slug of NON_ACTIVE_SLUGS) expect(items.some((s) => s.slug === slug)).toBe(false);
	});

	it('computeFacets counts only active sources', async () => {
		const f = await queries.computeFacets({});
		const total = f.categories.reduce((n, b) => n + b.count, 0);
		expect(total).toBe(2);
		expect(f.categories.find((b) => b.key === 'primary')?.count).toBe(1); // only W, not H/L/D/C
		expect(f.categories.find((b) => b.key === 'secondary')?.count).toBe(1); // A2
	});

	it('quickSearch excludes non-active matches', async () => {
		const rows = await queries.quickSearch('Work');
		// "Winner Work" is active; "Loser/Hidden/Deleted/Candidate Work" are not.
		expect(rows.map((s) => s.slug)).toEqual(['winner']);
	});

	it('getStats totals + withDigital count only active sources', async () => {
		const s = await queries.getStats();
		expect(s.total).toBe(2);
		expect(s.withDigital).toBe(1); // only W's link counts (H's + L's are non-active)
	});

	it('getTimeline lists only active sources', async () => {
		const pts = await queries.getTimeline();
		expect(pts.map((p) => p.slug).sort()).toEqual(['active-two', 'winner']);
	});

	it('getTimelineDensity groups active dated sources by year and category', async () => {
		await db.insert(schema.sources).values([
			{
				id: 'density-primary',
				slug: 'density-primary',
				title: 'Second Primary Work',
				category: 'primary',
				type: 'book',
				yearStart: 1900,
				status: 'active'
			},
			{
				id: 'density-corpus',
				slug: 'density-corpus',
				title: 'Corpus Work',
				category: 'corpus',
				type: 'corpus-text',
				yearStart: 1900,
				status: 'active'
			},
			{
				id: 'density-undated',
				slug: 'density-undated',
				title: 'Undated Work',
				category: 'primary',
				type: 'book',
				yearStart: null,
				status: 'active'
			}
		]);

		expect(await queries.getTimelineDensity()).toEqual([
			{ year: 1900, category: 'corpus', count: 1 },
			{ year: 1900, category: 'primary', count: 2 },
			{ year: 1905, category: 'secondary', count: 1 }
		]);
	});

	it('getTimelineDensity uses its covering index without temporary B-trees', async () => {
		const client = createClient({ url: `file:${DB_PATH}` });
		try {
			const plan = await client.execute(`
				EXPLAIN QUERY PLAN
				SELECT year_start, category, count(*)
				FROM sources
				WHERE status = 'active' AND year_start IS NOT NULL
				GROUP BY year_start, category
				ORDER BY year_start ASC, category ASC
			`);
			const details = plan.rows.map((row) => String(row.detail));
			expect(details.join('\n')).toContain(
				'USING COVERING INDEX sources_status_year_category_idx'
			);
			expect(details.some((detail) => detail.includes('USE TEMP B-TREE'))).toBe(false);
		} finally {
			client.close();
		}
	});

	it('listPlaces counts only active sources per place', async () => {
		const places = await queries.listPlaces();
		expect(places.find((p) => p.slug === 'pl1')?.sourceCount).toBe(1); // W only, not H
	});

	it('getCitationNetwork includes only accepted edges between active sources', async () => {
		const net = await getCitationNetwork();
		expect(net.nodes.map((n) => n.slug).sort()).toEqual(['active-two', 'winner']);
		expect(net.stats.edges).toBe(1); // only w→a2; w→h (hidden), w→c (candidate), l→a2 (merged) dropped
	});

	it('sitemap queries list only active source and entity slugs', async () => {
		const sourceRows = await allSitemapSources();
		expect(sourceRows.map((source) => source.slug).sort()).toEqual(['active-two', 'winner']);
		expect(await queries.getSitemapEntities('people')).toEqual([
			expect.objectContaining({ slug: 'p1' })
		]);
		expect(await queries.getSitemapEntities('places')).toEqual([{ slug: 'pl1' }]);
		expect(await queries.getSitemapEntities('institutions')).toEqual([{ slug: 'i1' }]);
	});

	it('assigns every range boundary and its neighboring slugs exactly once', async () => {
		await wipe();
		const boundaries = sourceSitemapShards.flatMap((shard) => shard.start === undefined ? [] : [shard.start]);
		const slugs = [...new Set([
			'0', '19-example', '190', '20-example', '200', 'z', '資料', '𐀀',
			...boundaries.flatMap((boundary) => [
				boundary.slice(0, -1) + String.fromCharCode(boundary.charCodeAt(boundary.length - 1) - 1) + '~',
				boundary, `${boundary}-example`
			])
		])];
		await db.insert(schema.sources).values(slugs.map((slug, index) => ({
			id: `boundary-${index}`, slug, title: 'Sitemap boundary fixture', category: 'primary', type: 'book', status: 'active'
		})));
		const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
		const seen: string[] = [];
		for (const shard of sourceSitemapShards) {
			const rows = await queries.getSitemapSources(shard);
			const expected = slugs.filter((slug) =>
				(shard.start === undefined || compare(slug, shard.start) >= 0) &&
				(shard.end === undefined || compare(slug, shard.end) < 0)
			).sort(compare);
			expect(rows.map((row) => row.slug), shard.id).toEqual(expected);
			seen.push(...rows.map((row) => row.slug));
		}
		expect(seen.sort(compare)).toEqual(slugs.sort(compare));
		expect(new Set(seen).size).toBe(seen.length);
	});

	it('detects a missing source sitemap covering index for every range', async () => {
		const client = createClient({ url: ':memory:' });
		try {
			await migrate(drizzle(client, { schema }), { migrationsFolder: MIGRATIONS });
			await client.execute('DROP INDEX sources_sitemap_idx');
			for (const query of sourceSitemapPlans) {
				const plan = await client.execute(`EXPLAIN QUERY PLAN ${query.sql}`);
				expect(() => assertCoveringPlan(plan.rows.map((row) => String(row.detail)), query.index)).toThrow();
			}
		} finally {
			client.close();
		}
	});

	it('serves every sitemap range from a covering index without temporary sorting', async () => {
		const cases = [
			...sourceSitemapPlans,
			{
				sql: `SELECT slug, updated_at FROM persons WHERE status = 'active' ORDER BY slug LIMIT 2001`,
				index: 'persons_sitemap_idx'
			},
			{
				sql: `SELECT slug FROM places WHERE status = 'active' ORDER BY slug LIMIT 2001`,
				index: 'places_sitemap_idx'
			},
			{
				sql: `SELECT slug FROM institutions WHERE status = 'active' ORDER BY slug LIMIT 2001`,
				index: 'institutions_sitemap_idx'
			}
		];

		for (const query of cases) {
			const details = await explain(query.sql);
			assertCoveringPlan(details, query.index);
		}
	});

	it('getSourceDetail resolves an active source and shows only accepted/active relations', async () => {
		const detail = await queries.getSourceDetail('winner');
		expect(detail).toBeDefined();
		expect(detail!.related.map((r) => r.source.slug)).toEqual(['active-two']); // not hidden/candidate/merged
	});

	it.each(NON_ACTIVE_SLUGS)('getSourceDetail(%s) is not-found (→ 404)', async (slug) => {
		expect(await queries.getSourceDetail(slug)).toBeUndefined();
	});

	it('a merged slug redirects to its active winner', async () => {
		expect(await queries.getMergeRedirectTarget('loser')).toBe('winner');
	});

	it.each(['hidden-src', 'deleted-src', 'cand-xyz-candidate', 'no-such-slug'])(
		'%s has no redirect target (→ 404, not a redirect)',
		async (slug) => {
			expect(await queries.getMergeRedirectTarget(slug)).toBeUndefined();
		}
	);

	it('getPersonBySlug lists only active works (and listPersons counts them)', async () => {
		const r = await queries.getPersonBySlug('p1');
		expect(r!.sources.map((x) => x.source.slug)).toEqual(['winner']);
		const list = await queries.listPersons();
		expect(list.find((p) => p.slug === 'p1')?.sourceCount).toBe(1);
	});

	it('getPlaceBySlug + listPlaces count only active works', async () => {
		const r = await queries.getPlaceBySlug('pl1');
		expect(r!.sources.map((x) => x.source.slug)).toEqual(['winner']);
		const list = await queries.listPlaces();
		expect(list.find((p) => p.slug === 'pl1')?.sourceCount).toBe(1);
	});

	it('getInstitutionBySlug + listInstitutions count only active works', async () => {
		const r = await queries.getInstitutionBySlug('i1');
		expect(r!.sources.map((x) => x.source.slug)).toEqual(['winner']);
		const list = await queries.listInstitutions();
		expect(list.find((i) => i.slug === 'i1')?.sourceCount).toBe(1);
	});

	it('listTags counts only active works', async () => {
		const list = await queries.listTags();
		expect(list.find((t) => t.slug === 'topic-one')?.sourceCount).toBe(1);
	});
});

// ===========================================================================
// 2. No-op proof: with the SAME fixture all-active, every previously-hidden row
//    reappears in exactly the expected count — the filter is status-only.
// ===========================================================================
describe('no-op on all-active data — the predicate filters by status and nothing else', () => {
	beforeEach(async () => seed(true));

	it('listSources / getStats / sitemap now include all six sources', async () => {
		expect((await queries.listSources({})).total).toBe(6);
		expect((await queries.getStats()).total).toBe(6);
		expect((await allSitemapSources()).length).toBe(6);
	});

	it('entity sitemaps include rows whose status becomes active', async () => {
		expect((await queries.getSitemapEntities('people')).map((row) => row.slug)).toEqual([
			'p1',
			'p2'
		]);
		expect((await queries.getSitemapEntities('places')).map((row) => row.slug)).toEqual([
			'pl1',
			'pl2'
		]);
		expect((await queries.getSitemapEntities('institutions')).map((row) => row.slug)).toEqual([
			'i1',
			'i2'
		]);
	});

	it('withDigital now counts all three linked sources', async () => {
		expect((await queries.getStats()).withDigital).toBe(3); // W + H + L
	});

	it('a formerly-hidden slug now resolves (no longer 404)', async () => {
		expect(await queries.getSourceDetail('hidden-src')).toBeDefined();
	});

	it('an active (non-merged) slug is never redirected', async () => {
		expect(await queries.getMergeRedirectTarget('loser')).toBeUndefined();
	});

	it('network, directory counts and relations expand to include the now-active rows', async () => {
		const net = await getCitationNetwork();
		// edges: w→a2, w→h, w→c, l→a2 → nodes {winner, active-two, hidden-src, cand-xyz-candidate, loser}
		expect(net.nodes.map((n) => n.slug).sort()).toEqual([
			'active-two',
			'cand-xyz-candidate',
			'hidden-src',
			'loser',
			'winner'
		]);
		expect(net.stats.edges).toBe(4);

		expect((await queries.getPersonBySlug('p1'))!.sources.length).toBe(2); // W + H
		expect((await queries.listPersons()).find((p) => p.slug === 'p1')?.sourceCount).toBe(2);
		expect((await queries.listPlaces()).find((p) => p.slug === 'pl1')?.sourceCount).toBe(2);
		expect((await queries.listTags()).find((t) => t.slug === 'topic-one')?.sourceCount).toBe(2);

		const detail = await queries.getSourceDetail('winner');
		expect(detail!.related.map((r) => r.source.slug).sort()).toEqual(['active-two', 'cand-xyz-candidate', 'hidden-src']);
	});
});
