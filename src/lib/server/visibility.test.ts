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
	await db.insert(schema.persons).values([{ id: 'p1', slug: 'p1', name: 'Person One' }]);
	await db.insert(schema.sourcePersons).values([
		{ sourceId: 'w', personId: 'p1', role: 'author' },
		{ sourceId: 'h', personId: 'p1', role: 'author' }
	]);
	await db.insert(schema.places).values([{ id: 'pl1', slug: 'pl1', name: 'Place One', lat: 43.06, lng: 141.35 }]);
	await db.insert(schema.sourcePlaces).values([
		{ sourceId: 'w', placeId: 'pl1', role: 'dialect' },
		{ sourceId: 'h', placeId: 'pl1', role: 'dialect' }
	]);
	await db.insert(schema.institutions).values([{ id: 'i1', slug: 'i1', name: 'Institution One' }]);
	await db.insert(schema.sourceInstitutions).values([
		{ sourceId: 'w', institutionId: 'i1', role: 'holding' },
		{ sourceId: 'h', institutionId: 'i1', role: 'holding' }
	]);
}

const NON_ACTIVE_SLUGS = ['loser', 'hidden-src', 'deleted-src', 'cand-xyz-candidate'];

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

	it('getMapPlaces counts only active sources per place', async () => {
		const places = await queries.getMapPlaces();
		expect(places.find((p) => p.slug === 'pl1')?.sourceCount).toBe(1); // W only, not H
	});

	it('getCitationNetwork includes only accepted edges between active sources', async () => {
		const net = await getCitationNetwork();
		expect(net.nodes.map((n) => n.slug).sort()).toEqual(['active-two', 'winner']);
		expect(net.stats.edges).toBe(1); // only w→a2; w→h (hidden), w→c (candidate), l→a2 (merged) dropped
	});

	it('getSitemapEntries lists only active source slugs', async () => {
		const { sources } = await queries.getSitemapEntries();
		expect(sources.map((s) => s.slug)).toEqual(['active-two', 'winner']);
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
		expect((await queries.getSitemapEntries()).sources.length).toBe(6);
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
		expect((await queries.getMapPlaces()).find((p) => p.slug === 'pl1')?.sourceCount).toBe(2);
		expect((await queries.listTags()).find((t) => t.slug === 'topic-one')?.sourceCount).toBe(2);

		const detail = await queries.getSourceDetail('winner');
		expect(detail!.related.map((r) => r.source.slug).sort()).toEqual(['active-two', 'cand-xyz-candidate', 'hidden-src']);
	});
});
