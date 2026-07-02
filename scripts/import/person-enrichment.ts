#!/usr/bin/env bun
/**
 * Feed #9 — PERSON ENRICHMENT post-pass (idempotent, OFFLINE). Runs AFTER the
 * source importers: it observes NO source and derives NO source→source edge — it
 * only backfills the `persons` entity rows' scholarly-identity scalars
 * (Wikidata QID / Wikipedia URL / birth+death years) from the ON-DISK caches the
 * bootstrap already populated. It NEVER hits the Wikidata API (so it is fully
 * deterministic + reproducible) and it is invisible to the SOURCE golden
 * projection, which captures persons only as { slug, role, sortOrder } — never
 * their wikidata/dates (src/lib/server/golden.ts). Enriching a person therefore
 * cannot change any source's rootHash (the gate below).
 *
 * The merge-engine-era replacement for seed.ts's `enrichPersonsWithWikidata` +
 * `enrichPersonDates` + `PERSON_OVERRIDES` fill loops, reproduced VERBATIM but
 * reading ONLY from the caches (never the network):
 *
 *   1. Wikidata cache (scripts/wikidata-cache.json), keyed by
 *      `ck(name) = stripParens(name).replace(/\s+/g,'')` — the SAME space/paren-
 *      insensitive key seed wrote. For each person: gap-fill `wikidata` and
 *      `wikipedia` from the cached hit, only where the row's value is empty.
 *
 *   2. Dates cache (scripts/wikidata-dates-cache.json), keyed by QID. Using the
 *      person's wikidata (curated OR just-filled in step 1 — seed's ordering, so a
 *      QID that came from PERSON_ENRICH still gets its dates), gap-fill
 *      `birthYear`, `deathYear` (only when NULL) and `wikipedia` (from the QID's
 *      sitelink when still empty).
 *
 *   3. PERSON_OVERRIDES — verified identity corrections, applied LAST exactly as
 *      seed did (they win over the cache), so a stale century-precision cache year
 *      (寺島良安's +1800) or a wrong merged QID (井上文夫) is suppressed rather than
 *      backfilled. Scoped to this pass's four columns.
 *
 * The three steps are replayed IN MEMORY per person to compute the FINAL desired
 * value of each column, then diffed against the stored row — an UPDATE is issued
 * only for columns that actually change, and (because steps 1–2 are gap-fill and
 * the prod bootstrap already carries the corrections of step 3) every write on the
 * live catalogue lands on a column that was EMPTY. No existing non-empty value is
 * ever overwritten; a second identical run computes the same finals and writes
 * ZERO rows (idempotent). NO wipe / delete / transaction — targeted by-id UPDATEs
 * only.
 *
 * Origin : 'person-enrichment' — one run + provenance stamp; there is no
 *          observationId (a person scalar is not asserted by a single source).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run].
 *
 * Run:  DATABASE_URL=file:/tmp/clone.db bun run import:person-enrichment
 *       DATABASE_URL=file:/tmp/clone.db bun run import:person-enrichment --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { stripParens } from './lib/derive';
import { openDb } from './lib/entities';
import { openRun, closeRun } from './lib/run';
import { persons } from '../../src/lib/server/db/schema';
import type { Db } from './lib/entities';

// ── argv ─────────────────────────────────────────────────────────────────────
function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}
const hasFlag = (flag: string) => process.argv.includes(flag);

const url = argValue('--db') ?? process.env.DATABASE_URL;
if (!url) {
	console.error('✗ No database specified. Pass --db file:/path/to/db or set DATABASE_URL.');
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}
const DRY_RUN = hasFlag('--dry-run');

const ORIGIN = 'person-enrichment';

// The caches live beside seed.ts (scripts/), NOT under $AINU_ROOT.
const WIKIDATA_CACHE_FILE = path.join(import.meta.dir, '..', 'wikidata-cache.json');
const WIKIDATA_DATES_CACHE_FILE = path.join(import.meta.dir, '..', 'wikidata-dates-cache.json');

// ── cache shapes (seed.ts §wikidata) ──────────────────────────────────────────
type WdHit = { wikidata: string | null; wikipedia: string | null; enLabel: string | null };
type DateHit = { b: number | null; d: number | null; wp?: string | null };

/**
 * seed.ts `PERSON_OVERRIDES`, VERBATIM. Verified corrections for persons carrying
 * wrong Wikidata-derived identity/dates, keyed by `name`; explicit null clears a
 * field. (Terashima's death is genuinely unknown — 没年不詳, cached as century-
 * precision +1800; 井上文夫 was merged with an unrelated comedian QID Q11366642.)
 */
const PERSON_OVERRIDES: Record<string, Record<string, unknown>> = {
	'寺島 良安': { deathYear: null },
	'井上 文夫': { birthYear: null, deathYear: null, wikidata: null, wikipedia: null, nameEn: 'Inoue Fumio' }
};

/** The four scalar columns this pass owns (seed's enrich targets); nameEn is not ours. */
const ENRICH_COLUMNS = ['wikidata', 'wikipedia', 'birthYear', 'deathYear'] as const;
type EnrichColumn = (typeof ENRICH_COLUMNS)[number];

/** seed's `ck` — space/parenthesis-insensitive cache key on the display name. */
const cacheKey = (name: string) => stripParens(name).replace(/\s+/g, '');
const isEmptyText = (v: string | null) => v == null || v === '';

function readJson<T>(file: string): Record<string, T> {
	if (!fs.existsSync(file)) return {};
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, T>;
	} catch {
		return {};
	}
}

/** The stored + computed scalars this pass reasons about (all nullable). */
interface PersonScalars {
	wikidata: string | null;
	wikipedia: string | null;
	birthYear: number | null;
	deathYear: number | null;
}

/**
 * Replay seed's enrich sequence for ONE person in memory, returning the final
 * desired scalars. Steps 1–2 gap-fill (never overwrite a non-empty value); step 3
 * applies the verified overrides last (seed's overwrite), scoped to our columns.
 */
function computeFinal(
	before: PersonScalars,
	name: string,
	wdCache: Record<string, WdHit>,
	datesCache: Record<string, DateHit>
): PersonScalars {
	const next: PersonScalars = { ...before };

	// 1. Wikidata cache (enrichPersonsWithWikidata): gap-fill QID + Wikipedia.
	const hit = wdCache[cacheKey(name)];
	if (hit) {
		if (isEmptyText(next.wikidata)) next.wikidata = hit.wikidata;
		if (isEmptyText(next.wikipedia)) next.wikipedia = hit.wikipedia;
	}

	// 2. Dates cache (enrichPersonDates): keyed by the QID from step 1 (or curated).
	const c = next.wikidata ? datesCache[next.wikidata] : null;
	if (c) {
		if (next.birthYear == null && c.b != null) next.birthYear = c.b;
		if (next.deathYear == null && c.d != null) next.deathYear = c.d;
		if (isEmptyText(next.wikipedia) && c.wp) next.wikipedia = c.wp;
	}

	// 3. PERSON_OVERRIDES (applied last; wins over the cache), our columns only.
	const ov = PERSON_OVERRIDES[name];
	if (ov) {
		for (const col of ENRICH_COLUMNS) {
			if (col in ov) next[col] = ov[col] as never;
		}
	}
	return next;
}

async function main() {
	console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}import:person-enrichment → ${url!.split('?')[0]}`);
	const db: Db = openDb(url!, authToken);

	const wdCache = readJson<WdHit>(WIKIDATA_CACHE_FILE);
	const datesCache = readJson<DateHit>(WIKIDATA_DATES_CACHE_FILE);
	console.log(`  caches: ${Object.keys(wdCache).length} wikidata, ${Object.keys(datesCache).length} dates`);

	// Deterministic order (slug is UNIQUE) so run1/run2 process persons identically.
	const rows = await db
		.select({
			id: persons.id,
			name: persons.name,
			wikidata: persons.wikidata,
			wikipedia: persons.wikipedia,
			birthYear: persons.birthYear,
			deathYear: persons.deathYear
		})
		.from(persons)
		.orderBy(asc(persons.slug));

	// Per-column tally + a hard guard that we only ever fill an EMPTY column.
	const filled: Record<EnrichColumn, number> = { wikidata: 0, wikipedia: 0, birthYear: 0, deathYear: 0 };
	const overwriteAttempts: { id: string; name: string; col: EnrichColumn; from: unknown; to: unknown }[] = [];
	let personsTouched = 0;

	const runId = DRY_RUN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-person-enrichment@1' });

	for (const row of rows) {
		const before: PersonScalars = {
			wikidata: row.wikidata,
			wikipedia: row.wikipedia,
			birthYear: row.birthYear,
			deathYear: row.deathYear
		};
		const next = computeFinal(before, row.name, wdCache, datesCache);

		const patch: Partial<PersonScalars> = {};
		for (const col of ENRICH_COLUMNS) {
			if (next[col] === before[col]) continue;
			const wasEmpty = col === 'wikidata' || col === 'wikipedia' ? isEmptyText(before[col] as string | null) : before[col] == null;
			// Never overwrite an existing non-empty value (fill-empty only). Record + skip.
			if (!wasEmpty) {
				overwriteAttempts.push({ id: row.id, name: row.name, col, from: before[col], to: next[col] });
				continue;
			}
			// A gap-fill whose value is still empty (e.g. override null → null) is a noop.
			const stillEmpty = col === 'wikidata' || col === 'wikipedia' ? isEmptyText(next[col] as string | null) : next[col] == null;
			if (stillEmpty) continue;
			(patch as Record<string, unknown>)[col] = next[col];
			filled[col] += 1;
		}

		if (Object.keys(patch).length === 0) continue;
		personsTouched += 1;
		if (!DRY_RUN) await db.update(persons).set(patch).where(eq(persons.id, row.id));
	}

	if (overwriteAttempts.length) {
		// Should be impossible on a seed-consistent DB (steps 1–2 are gap-fill and the
		// bootstrap already carries step 3's corrections). Surface loudly if it ever isn't.
		console.warn(`  ! ${overwriteAttempts.length} non-empty value(s) would have been overwritten — SKIPPED (fill-empty only):`);
		for (const a of overwriteAttempts.slice(0, 10)) console.warn(`      ${a.name} .${a.col}: ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)} (kept ${JSON.stringify(a.from)})`);
	}

	const summary = {
		personsScanned: rows.length,
		personsTouched,
		filled,
		overwritesSkipped: overwriteAttempts.length
	};
	if (!DRY_RUN && runId) await closeRun(db, runId, { status: 'completed', summary });

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: scanned ${rows.length} persons, ${personsTouched} enriched ` +
			`(wikidata +${filled.wikidata}, wikipedia +${filled.wikipedia}, birthYear +${filled.birthYear}, deathYear +${filled.deathYear})`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:person-enrichment failed:', err);
		process.exit(1);
	});
