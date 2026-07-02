#!/usr/bin/env bun
/**
 * Feed #6 — Curated bibliographies importer (idempotent).
 *
 * The merge-engine replacement for seed.ts's `seedCuratedBiblio`. Reads
 * scripts/data/curated-biblio.json (the hand-entered reading lists — the 幕別町
 * 図書館 十勝-Ainu list, the 帯広百年記念館 リウカ web tools, …) and, for each entry
 * IN FILE ORDER, derives the SAME fields seed.ts did (via scripts/import/lib/
 * derive.ts, byte-for-byte) and submits ONE `curated_assertion` observation per
 * entry through mergeSourceObservation.
 *
 * seed.ts's "enrich an existing record by normalized-title match, else insert a
 * new source" branch is NOT special-cased here: the engine reproduces it for
 * free. A record whose bootstrapped source carries the `curated-makubetsu:biblio/
 * <num>` repo_path attaches to it (repo_path_exact); a record that seed ENRICHED
 * onto a pre-existing NDL/CiNii/dictionary source (so it has no curated-makubetsu
 * source of its own) attaches by title/coreText — and, because this observation
 * sits at the same 0.8 band as the bootstrapped values, the engine's no-clobber
 * rule holds the differing scalars (category/type/…) as conflicts while filling
 * only the empties (holdingInstitution / callNumber / summary) and set-union-
 * merging the link — exactly the seed enrich semantics.
 *
 * Origin        : 'curated-makubetsu'
 * Idempotency key: (origin, originRecordId = 'biblio/<num>', contentHash) — the
 *                  engine's observation UNIQUE index. A re-run with an unchanged
 *                  file is a dup-noop (zero projection change).
 * Identity key  : identifier repo_path = 'curated-makubetsu:biblio/<num>' lowercased
 *                  (matches the bootstrap's `${repo}:${path}` form, colon-joined —
 *                  a SLASH separator would fork a duplicate). → repo_path_exact.
 * Derivation    : curated_assertion @ 0.8 (≤ the bootstrap band, so it never
 *                  clobbers a bootstrapped/editorial value; noop-by-valueHash
 *                  regardless).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun run import:curated-biblio
 *       DATABASE_URL=file:/tmp/clone.db bun run import:curated-biblio --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { geoSubjectText, TAG_DEFS } from './lib/derive';
import { openDb, addPersons, addPlaces, attachTags, type EntityStamp } from './lib/entities';
import { openRun, closeRun, emitSource, driftMissing } from './lib/run';
import type { MergeInput } from '../../src/lib/server/merge';

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

// curated-biblio.json lives beside seed.ts (scripts/data), NOT under $AINU_ROOT.
const CURATED_BIBLIO_FILE = path.join(import.meta.dir, '..', 'data', 'curated-biblio.json');

const ORIGIN = 'curated-makubetsu';
const DERIVATION = 'curated_assertion';
const CONFIDENCE = 0.8;

/** One curated bibliography record (mirrors seed.ts's `CuratedEntry`). */
interface CuratedEntry {
	num: string;
	title: string;
	titleEn?: string | null;
	authors: string[];
	publisher?: string;
	year?: number | null;
	type: string;
	category: string;
	langs: string[];
	scripts?: string[];
	url?: string;
	urlType?: string;
	summary?: string;
	holding?: string;
	callNumber?: string;
	dialect?: string;
}

/**
 * Derive the engine `fields` map + link for one curated entry — byte-identical to
 * seed.ts's `seedCuratedBiblio` new-source row build. Empty/null values are OMITTED
 * (the engine skips empties anyway, and omitting avoids empty-overwrite noise on the
 * historically-populated clone); the returned author/dialect/placeText/tagTexts are
 * the raw strings used for the entity graph, matching seed's addPersons/addPlaces/
 * attachTags calls verbatim.
 */
function deriveEntry(e: CuratedEntry): {
	fields: Record<string, unknown>;
	author: string;
	placeText: string;
	tagTexts: (string | null | undefined)[];
	link: { type: string; url: string; label: string | null } | null;
} {
	const author = e.authors.join('、');

	const fields: Record<string, unknown> = {
		title: e.title,
		category: e.category,
		type: e.type,
		languages: e.langs,
		scripts: e.scripts ?? ['kana', 'kanji'],
		yearCertainty: e.year ? 'exact' : 'unknown'
	};
	if (e.titleEn) fields.titleEn = e.titleEn;
	if (author) fields.author = author;
	if (e.year) {
		fields.yearText = String(e.year);
		fields.yearStart = e.year;
	}
	if (e.dialect) fields.dialect = e.dialect;
	if (e.holding) fields.holdingInstitution = e.holding;
	if (e.callNumber) fields.callNumber = e.callNumber;
	if (e.summary) fields.summary = e.summary;

	const link = e.url
		? { type: e.urlType ?? 'website', url: e.url, label: e.publisher ?? null }
		: null;

	return {
		author,
		placeText: `${geoSubjectText(e.title)} ${e.dialect ?? ''}`,
		tagTexts: [e.title, e.titleEn, e.summary],
		fields,
		link
	};
}

async function main() {
	if (!fs.existsSync(CURATED_BIBLIO_FILE)) {
		console.error(`✗ curated biblio file not found: ${CURATED_BIBLIO_FILE}`);
		process.exit(1);
	}
	const entries: CuratedEntry[] = JSON.parse(fs.readFileSync(CURATED_BIBLIO_FILE, 'utf8'));
	const slice = LIMIT === Infinity ? entries : entries.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:curated-biblio → ${url!.split('?')[0]}  (${slice.length}/${entries.length} entries)`
	);

	const db = openDb(url!, authToken);
	const runId = DRY_RUN
		? null
		: await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-curated-biblio@1' });

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, created: 0, other: 0 };

	for (const e of slice) {
		const recordId = `biblio/${e.num}`;
		seen.add(recordId);
		const { fields, author, placeText, tagTexts, link } = deriveEntry(e);

		if (DRY_RUN) {
			console.log(`  ${recordId}: ${Object.keys(fields).length} fields${link ? ' +link' : ''}`);
			continue;
		}

		const input: MergeInput = {
			origin: ORIGIN,
			originRecordId: recordId,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields,
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${recordId}`.toLowerCase() }],
			links: link ? [link] : [],
			presence: 'seen',
			runId,
			rawPayload: e as unknown as Record<string, unknown>
		};

		const result = await emitSource(db, input, { provenanceRepo: ORIGIN, provenancePath: recordId });
		if (result.status === 'noop') stats.noop += 1;
		else if (result.status === 'applied') stats.applied += 1;
		else stats.other += 1;

		const sid = result.sourceId;
		if (!sid) continue;
		const stamp: EntityStamp = {
			origin: ORIGIN,
			observationId: result.observationId,
			confidence: CONFIDENCE,
			now: new Date()
		};
		await addPersons(db, sid, author, stamp);
		await addPlaces(db, sid, placeText, stamp, 'subject');
		await attachTags(db, sid, tagTexts, stamp, TAG_DEFS);
	}

	let drifted = 0;
	if (!DRY_RUN) {
		drifted = await driftMissing(db, ORIGIN, seen, { derivation: DERIVATION, confidence: CONFIDENCE, runId });
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, entries: slice.length }
		});
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:curated-biblio failed:', err);
		process.exit(1);
	});
