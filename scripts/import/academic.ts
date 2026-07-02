#!/usr/bin/env bun
/**
 * Feed #5 — Academic harvest importer (idempotent). THE LARGEST FEED: 5,767
 * records (most of the 5,806-source catalogue).
 *
 * The merge-engine replacement for seed.ts's `seedAcademic`. Reads
 * scripts/data/academic-index.json and, for each record IN FILE ORDER, derives the
 * SAME fields/links seed.ts did (via scripts/import/lib/derive.ts, byte-for-byte)
 * and submits ONE `extracted` observation per record through mergeSourceObservation,
 * then reconciles its gated-author / subject-place / topical+venue tag entities.
 *
 * seed.ts's "enrich an existing record by DOI / normalized-title / fuzzy-core match,
 * else insert a new source" branch is NOT re-implemented: the engine reproduces the
 * strong-id and title+author+year (medium) paths for free. A record whose
 * bootstrapped source carries the matching doi / openalex_work attaches
 * (strong_single); a DOI-less record attaches by coreText+author+year corroboration
 * (medium); a record seed loosely enriched-by-title that the engine's STRICT identity
 * refuses forks to a new (review-candidate) source — accepted as additive, never a
 * clobber (extracted @ 0.7 sits BELOW the bootstrap band, Risk F).
 *
 * Origin        : rec.source (openalex | crossref | cinii | jstage | ndl | togo |
 *                 researchmap | irdb | huggingface | qiita | note | …) — one harvest
 *                 run per distinct origin, matching the bootstrap's provenanceRepo.
 * Idempotency key: (origin, originRecordId = rec.externalId, contentHash) — the
 *                  engine's observation UNIQUE index. A re-run over the SAME index is
 *                  a dup-noop: identity resolution is SKIPPED and ZERO source /
 *                  entity write happens (a forked source is NOT re-forked). This is
 *                  what makes the golden run1→run2 rootHash identical.
 * Identity keys : `doi` (strong, when present) + the source-type strong id the
 *                 Phase-3 bootstrap wrote for rec.source — doi(crossref) /
 *                 openalex_work(openalex) / cinii(cinii,cinii-books) / ndl(ndl) /
 *                 jstage(jstage), value = rec.externalId (SOURCE_ID_KIND == bootstrap
 *                 ID_KIND_MAP). So a DOI-less cinii/ndl/cinii-books record attaches to
 *                 its bootstrapped source via strong_single instead of forking.
 *                 repo_path is deliberately NOT emitted for academic; an origin absent
 *                 from the map (togo/researchmap/irdb/…) still keys on coreText+author+year.
 * Derivation    : extracted @ 0.7 (band 700 < the bootstrap's curated_assertion band
 *                  800, so it never clobbers a bootstrapped/editorial value; a
 *                  matching value noops by value-hash, a differing one is held_below).
 *
 * Determinism (Risk H): records are processed in a FIXED file order; per-record
 * link + identifier arrays are emitted in a fixed order; set fields are canonically
 * sorted by the engine. So the observation contentHash is stable across runs and the
 * forked-source SET is identical run-to-run.
 *
 * Resumable: a `migration_watermarks` row ('import:academic', cursor = last emitted
 * originRecordId) lets a crash mid-5.7k resume — on restart, records up to and
 * including the cursor are counted as seen (so drift stays correct) but NOT re-emitted.
 *
 * Citations: the OpenAlex citation graph (citation-edges.json) is a LATER relations
 * post-pass and is intentionally NOT built here.
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun run import:academic
 *       DATABASE_URL=file:/tmp/clone.db bun run import:academic --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import {
	decodeEntities,
	isLatinTitle,
	parseYear,
	detectScripts,
	slugify,
	geoSubjectText,
	authorParts,
	isGarbageName,
	simplePersonKey,
	INSTITUTION_RE,
	canonicalSlugFor,
	normTitle,
	classifyAcademic,
	META_LANG,
	AUTHOR_OVERRIDES,
	SOURCE_YEAR_OVERRIDES,
	TAG_DEFS
} from './lib/derive';
import {
	openDb,
	addPersonsGated,
	addPlaces,
	attachTags,
	attachVenueTags,
	type Db,
	type EntityStamp
} from './lib/entities';
import { openRun, closeRun, emitSource, driftMissing } from './lib/run';
import { migrationWatermarks } from '../../src/lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { LinkInput, MergeInput } from '../../src/lib/server/merge';

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
const LIMIT = argValue('--limit') ? Number(argValue('--limit')) : Infinity;

// academic-index.json lives beside seed.ts (scripts/data), NOT under $AINU_ROOT.
const ACADEMIC_FILE = path.join(import.meta.dir, '..', 'data', 'academic-index.json');

const JOB = 'import:academic';
const DERIVATION = 'extracted';
const CONFIDENCE = 0.7;
const AUTHOR_MIN_WORKS = 2;

/**
 * rec.source → the `source_identifiers.kind` the Phase-3 bootstrap wrote for that
 * record. MUST stay byte-identical to scripts/bootstrap-ledger.ts's ID_KIND_MAP:
 * the bootstrap keyed off each source's externalIds object, whose keys were
 * seed.ts's `{ doi?, [rec.source]: rec.externalId }` (seed.ts §seedAcademic, line
 * ~1127). So the (kind,value) this emits per record is exactly what the bootstrap
 * indexed — letting a re-import resolve to the bootstrapped source via STRONG_SINGLE
 * instead of forking. Every kind here is in STRONG_ID_KINDS (merge/constants.ts).
 *
 * The `doi` externalIds key is handled separately below (rec.doi). rec.source values
 * ABSENT from this map (togo · researchmap · irdb · openlibrary · ndldigital ·
 * glottolog · qiita · huggingface · hoppodb · internetarchive · cyberleninka · sgu ·
 * honkoku · kokusho) were given NO strong identifier by the bootstrap (only a medium
 * repo_path, which this importer deliberately does not emit), so a DOI-less record
 * from one of those origins still resolves by coreText+author+year (medium) or forks.
 */
const SOURCE_ID_KIND: Record<string, string> = {
	crossref: 'doi', // crossref externalId IS the DOI
	openalex: 'openalex_work',
	cinii: 'cinii',
	'cinii-books': 'cinii',
	ndl: 'ndl',
	jstage: 'jstage'
};

/** One academic-index record (mirrors seed.ts's `Rec`). */
interface Rec {
	source: string;
	externalId: string;
	doi: string | null;
	title: string;
	year: number | null;
	type: string;
	language: string | null;
	authors: string[];
	venue: string | null;
	url: string | null;
	pdf: string | null;
	category?: string;
	rawType?: string;
	links?: { type: string; url: string; label?: string | null }[];
}

/**
 * Prominence pre-pass (seed.ts §seedAcademic, verbatim): scan ALL records and count
 * each non-institution/non-garbage author part on a space/comma-insensitive key. An
 * author with ≥ AUTHOR_MIN_WORKS works — PLUS every verified AUTHOR_OVERRIDES name
 * (correct by construction, so promoted past the frequency gate) — is promoted to a
 * person entity. The frozen Set is handed to addPersonsGated per record so /people
 * stays curated exactly as the bootstrap projection was built.
 */
function computeProminentAuthors(records: Rec[]): Set<string> {
	const authorCount = new Map<string, number>();
	for (const rec of records) {
		if (rec.category === 'tool') continue; // HF orgs / Qiita handles aren't people
		for (const a of rec.authors ?? [])
			for (const part of authorParts(String(a))) {
				if (INSTITUTION_RE.test(part) || isGarbageName(part)) continue;
				const k = simplePersonKey(part);
				if (k) authorCount.set(k, (authorCount.get(k) ?? 0) + 1);
			}
	}
	const prominent = new Set(
		[...authorCount].filter(([, n]) => n >= AUTHOR_MIN_WORKS).map(([k]) => k)
	);
	for (const names of Object.values(AUTHOR_OVERRIDES))
		for (const a of names)
			for (const part of authorParts(a)) {
				const k = simplePersonKey(part);
				if (k) prominent.add(k);
			}
	return prominent;
}

/**
 * Derive the engine `fields` + link inputs for one record — byte-identical to
 * seed.ts's `seedAcademic` new-source row build. MUTATES rec.title (HTML strip +
 * entity decode), rec.authors (AUTHOR_OVERRIDES) and rec.year (SOURCE_YEAR_OVERRIDES)
 * in place, exactly as seed did, so the entity graph + rawPayload see the corrected
 * values. Empty/null scalars are OMITTED (the engine skips empties anyway; omitting
 * avoids empty-overwrite noise on the historically-populated clone). Returns
 * `skip:true` for an untitled record (seed's `!normTitle(title)` skip).
 */
function deriveRecord(rec: Rec): {
	skip: boolean;
	fields: Record<string, unknown>;
	identifiers: MergeInput['identifiers'];
	links: LinkInput[];
	classified: { category: string; type: string };
} {
	// Strip HTML markup Crossref/CiNii embed in titles; decode common entities.
	if (rec.title)
		rec.title = decodeEntities(rec.title)
			.replace(/<\/?(b|i|em|strong|sub|sup|scp|sc|inf|span|u|tt|small|var|mml:[a-z]+)\b[^>]*>/gi, '')
			.replace(/\s+/g, ' ')
			.trim();

	const nt = normTitle(rec.title);
	const empty: ReturnType<typeof deriveRecord> = {
		skip: true,
		fields: {},
		identifiers: [],
		links: [],
		classified: { category: 'secondary', type: 'article' }
	};
	if (!nt) return empty;

	const doi = rec.doi?.toLowerCase() ?? null;
	const override = AUTHOR_OVERRIDES[doi ?? ''] ?? AUTHOR_OVERRIDES[`${rec.source}:${rec.externalId}`];
	if (override) rec.authors = override;
	const yearOv = SOURCE_YEAR_OVERRIDES[doi ?? ''] ?? SOURCE_YEAR_OVERRIDES[`${rec.source}:${rec.externalId}`];
	if (yearOv != null) rec.year = yearOv;

	const y = parseYear(rec.year != null ? String(rec.year) : '');
	const metalang = rec.language && META_LANG[rec.language] ? META_LANG[rec.language] : null;
	const cls = classifyAcademic(rec);
	const authors = rec.authors ?? [];

	const fields: Record<string, unknown> = {
		title: rec.title,
		category: cls.category,
		type: cls.type,
		languages: metalang ? ['ain', metalang] : ['ain'],
		scripts: detectScripts(rec.title),
		yearCertainty: y.yearCertainty
	};
	// Only mirror the title into title_en when it is genuinely Latin-script.
	if (isLatinTitle(rec.title)) fields.titleEn = rec.title;
	const authorStr = authors.join(', ');
	if (authorStr) fields.author = authorStr;
	if (y.yearText) fields.yearText = y.yearText;
	if (y.yearStart != null) fields.yearStart = y.yearStart;
	if (y.yearEnd != null) fields.yearEnd = y.yearEnd;
	if (rec.venue) fields.summary = rec.venue;

	// Identity: doi (strong) + the source-type strong id the Phase-3 bootstrap wrote
	// for rec.source (SOURCE_ID_KIND == bootstrap ID_KIND_MAP), value = rec.externalId,
	// normalized identically by the engine (merge/normalize.ts == bootstrap normId).
	// This lets a DOI-less cinii / ndl / cinii-books / jstage record attach to its
	// bootstrapped source via strong_single instead of forking. Emitted in a FIXED
	// order (doi, then source-type — Risk H); a crossref record whose source-type kind
	// IS 'doi' with the same value is a harmless dup (engine dedupes on (kind,valueNorm)).
	// NO repo_path — identity is a strong id, else coreText+author+year.
	const identifiers: MergeInput['identifiers'] = [];
	if (rec.doi) identifiers.push({ kind: 'doi', value: rec.doi });
	const srcKind = SOURCE_ID_KIND[rec.source];
	if (srcKind && rec.externalId) identifiers.push({ kind: srcKind, value: rec.externalId });

	// Links in a FIXED order (Risk H), locally deduped by url like seed's linkSeen.
	const links: LinkInput[] = [];
	const linkUrls = new Set<string>();
	const addLink = (type: string, u: string | null | undefined, label: string | null | undefined) => {
		if (!u || linkUrls.has(u)) return;
		linkUrls.add(u);
		links.push({ type, url: u, label: label ?? null });
	};
	if (rec.url) addLink(doi ? 'doi' : 'website', rec.url, doi ? `doi:${rec.doi}` : rec.venue);
	if (rec.pdf) addLink('pdf', rec.pdf, 'Open access PDF');
	for (const l of rec.links ?? []) addLink(l.type, l.url, l.label);

	return { skip: false, fields, identifiers, links, classified: cls };
}

// ── watermark (resumability) ──────────────────────────────────────────────────
async function readCursor(db: Db): Promise<string | null> {
	const [row] = await db
		.select({ status: migrationWatermarks.status, cursor: migrationWatermarks.cursor })
		.from(migrationWatermarks)
		.where(eq(migrationWatermarks.jobName, JOB))
		.limit(1);
	// Only resume a run that CRASHED mid-flight (status='running'); a 'completed'
	// row means the previous import finished, so a fresh invocation re-runs in full
	// (every record a dup-noop) rather than skipping anything.
	return row && row.status === 'running' && row.cursor ? row.cursor : null;
}

async function writeWatermark(
	db: Db,
	set: { cursor: string | null; status: string; summary?: Record<string, unknown> }
): Promise<void> {
	const now = new Date();
	await db
		.insert(migrationWatermarks)
		.values({ jobName: JOB, phase: 'feed-5-academic', cursor: set.cursor, status: set.status, summary: set.summary ?? null, updatedAt: now })
		.onConflictDoUpdate({
			target: migrationWatermarks.jobName,
			set: { phase: 'feed-5-academic', cursor: set.cursor, status: set.status, summary: set.summary ?? null, updatedAt: now }
		});
}

async function main() {
	if (!fs.existsSync(ACADEMIC_FILE)) {
		console.error(`✗ academic index not found: ${ACADEMIC_FILE}\n  Run collect-academic.ts first.`);
		process.exit(1);
	}
	const records: Rec[] = JSON.parse(fs.readFileSync(ACADEMIC_FILE, 'utf8'));
	const selected = LIMIT === Infinity ? records : records.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:academic → ${url!.split('?')[0]}  (${selected.length}/${records.length} records)`
	);

	// Prominence pre-pass over ALL records (frozen before the per-record loop).
	const prominentAuthors = computeProminentAuthors(records);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}academic: ${prominentAuthors.size} authors promoted to person entities (≥${AUTHOR_MIN_WORKS} works + overrides)`
	);

	const db = openDb(url!, authToken);

	// Resume point (full runs only). On resume we still count already-done records as
	// SEEN so drift never marks them missing, but we do NOT re-emit them.
	const resumeAfter = DRY_RUN || LIMIT !== Infinity ? null : await readCursor(db);
	let reached = resumeAfter == null;
	if (resumeAfter) console.log(`  resuming after cursor originRecordId=${resumeAfter}`);

	// One run + one seen-set per distinct origin (rec.source), opened lazily.
	const runByOrigin = new Map<string, string>();
	const seenByOrigin = new Map<string, Set<string>>();
	const runIdFor = async (origin: string): Promise<string> => {
		let id = runByOrigin.get(origin);
		if (!id) {
			id = await openRun(db, { origin, mode: 'full', collectorVersion: 'import-academic@1' });
			runByOrigin.set(origin, id);
		}
		return id;
	};
	const markSeen = (origin: string, recordId: string) => {
		let s = seenByOrigin.get(origin);
		if (!s) { s = new Set(); seenByOrigin.set(origin, s); }
		s.add(recordId);
	};

	const stats = { emitted: 0, applied: 0, noop: 0, candidate: 0, conflict: 0, other: 0, skippedUntitled: 0, resumeSkipped: 0 };
	let processedSinceCheckpoint = 0;

	for (const rec of selected) {
		const origin = rec.source;
		const recordId = rec.externalId;
		const derived = deriveRecord(rec);
		if (derived.skip) {
			stats.skippedUntitled += 1;
			continue;
		}
		// Count as seen for drift REGARDLESS of resume-skip (it WAS emitted last run).
		markSeen(origin, recordId);

		if (!reached) {
			if (recordId === resumeAfter) reached = true; // cursor record already done
			stats.resumeSkipped += 1;
			continue;
		}

		if (DRY_RUN) {
			stats.emitted += 1;
			if (stats.emitted <= 5)
				console.log(`  [${origin}] ${recordId}: ${Object.keys(derived.fields).length} fields, ${derived.identifiers?.length ?? 0} ids, ${derived.links.length} links`);
			continue;
		}

		const runId = await runIdFor(origin);
		const input: MergeInput = {
			origin,
			originRecordId: recordId,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields: derived.fields,
			identifiers: derived.identifiers,
			links: derived.links,
			presence: 'seen',
			runId,
			rawPayload: rec as unknown as Record<string, unknown>
		};

		const result = await emitSource(db, input, { provenanceRepo: origin, provenancePath: recordId });
		stats.emitted += 1;
		if (result.status === 'noop') stats.noop += 1;
		else if (result.status === 'applied' || result.status === 'partial') stats.applied += 1;
		else if (result.status === 'candidate') stats.candidate += 1;
		else if (result.status === 'conflict') stats.conflict += 1;
		else stats.other += 1;

		const sid = result.sourceId;
		if (sid) {
			const stamp: EntityStamp = {
				origin,
				observationId: result.observationId,
				confidence: CONFIDENCE,
				now: new Date()
			};
			// gated authors (prominent set) · subject-area places · title/type/venue tags
			await addPersonsGated(db, sid, rec.authors ?? [], prominentAuthors, stamp);
			await addPlaces(db, sid, geoSubjectText(rec.title), stamp, 'subject');
			await attachTags(db, sid, [rec.title, derived.classified.type, rec.venue], stamp, TAG_DEFS);
			await attachVenueTags(db, sid, rec.venue, stamp, TAG_DEFS);
		}

		processedSinceCheckpoint += 1;
		if (processedSinceCheckpoint >= 250) {
			await writeWatermark(db, { cursor: recordId, status: 'running' });
			processedSinceCheckpoint = 0;
			console.log(`  … ${stats.emitted} emitted (applied=${stats.applied} noop=${stats.noop} fork≈${stats.candidate + stats.conflict})`);
		}
	}

	let drifted = 0;
	if (!DRY_RUN) {
		// Drift only on a COMPLETE run (a --limit slice would falsely mark the rest
		// missing). Per origin: re-observe any observed_record of that origin not seen
		// this run as presence:'missing' (driftStatus only; never a delete).
		if (LIMIT === Infinity) {
			for (const [origin, seen] of seenByOrigin) {
				drifted += await driftMissing(db, origin, seen, {
					derivation: DERIVATION,
					confidence: CONFIDENCE,
					runId: runByOrigin.get(origin) ?? null
				});
			}
		}
		for (const [origin, runId] of runByOrigin) {
			await closeRun(db, runId, { status: 'completed', summary: { ...stats, drifted, origin } });
		}
		await writeWatermark(db, { cursor: null, status: 'completed', summary: { ...stats, drifted } });
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: emitted=${stats.emitted} applied=${stats.applied} noop=${stats.noop} candidate=${stats.candidate} conflict=${stats.conflict} other=${stats.other} untitled-skipped=${stats.skippedUntitled} resume-skipped=${stats.resumeSkipped} drifted-missing=${drifted} origins=${runByOrigin.size || seenByOrigin.size}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:academic failed:', err);
		process.exit(1);
	});
