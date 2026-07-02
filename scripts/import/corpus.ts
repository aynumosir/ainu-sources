#!/usr/bin/env bun
/**
 * Feed #3 — Corpus collections importer (idempotent).
 *
 * The merge-engine replacement for seed.ts's `seedCorpus`. STREAMS
 * $AINU_ROOT/ainu-corpora/data.jsonl (≈140 MB) and aggregates every sentence by
 * `collection_lv1` — EXACTLY as seed.ts does — into one observation per
 * collection (~40). Each aggregate derives the SAME fields/links/entities seed.ts
 * built (via scripts/import/lib/{derive,entities}.ts, byte-for-byte) and is
 * submitted through mergeSourceObservation. The engine attaches to the existing
 * source by its `repo_path` identifier, emits value-hash noop claims (no duplicate
 * source), then this importer reconciles the speaker/place/institution/tag
 * entities idempotently.
 *
 * Origin        : 'ainu-corpora'
 * Idempotency key: (origin, originRecordId = collection_lv1, contentHash) — the
 *                  engine's observation UNIQUE index. A re-run over the SAME
 *                  data.jsonl is a dup-noop (zero projection change).
 * Identity key  : identifier repo_path = 'ainu-corpora:<collection>' (a COLON, matching
 *                  the bootstrap's `${repo}:${path}` form → repo_path_exact attach;
 *                  a slash would fork a duplicate). Normalized lowercase by the engine.
 * Derivation    : observed @ 0.7 (band 700 < the bootstrap's curated_assertion band
 *                  800, so it never clobbers a bootstrapped/editorial value; a
 *                  matching value noops by value-hash, a differing one is held_below —
 *                  either way the projection is preserved).
 *
 * Determinism (Risk H): the file is streamed once in a fixed order (so Set insertion
 * order — hence the sliced dialect label / capped URIs — is stable across runs), and
 * the aggregates are emitted in a stable order SORTED by collection. The projected
 * field values are byte-identical to seed.ts (same insertion-order derivation).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun run import:corpus
 *       DATABASE_URL=file:/tmp/clone.db bun run import:corpus --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
	CORPUS_META,
	INSTITUTIONS,
	TAG_DEFS,
	linkTypeFor
} from './lib/derive';
import {
	openDb,
	addPersons,
	addPlaces,
	addInstitution,
	attachTags,
	type EntityStamp
} from './lib/entities';
import { openRun, closeRun, emitSource, driftMissing } from './lib/run';
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

const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(import.meta.dir, '../../..');
const CORPUS_FILE = path.join(AINU_ROOT, 'ainu-corpora', 'data.jsonl');

const ORIGIN = 'ainu-corpora';
const DERIVATION = 'observed';
const CONFIDENCE = 0.7;

// ── aggregate (mirrors seed.ts's CorpusAgg + streaming loop, VERBATIM) ─────────
interface CorpusAgg {
	collection: string;
	n: number;
	documents: Set<string>;
	dialects: Set<string>;
	dialectL1: Set<string>;
	recordedYears: number[];
	publishedYears: number[];
	uris: Set<string>;
	authors: Set<string>;
}

async function aggregate(): Promise<Map<string, CorpusAgg>> {
	const aggs = new Map<string, CorpusAgg>();
	const rl = readline.createInterface({
		input: fs.createReadStream(CORPUS_FILE, 'utf8'),
		crlfDelay: Infinity
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const collection = (rec.collection_lv1 as string) || '';
		if (!collection || collection === 'null') continue;
		let a = aggs.get(collection);
		if (!a) {
			a = {
				collection,
				n: 0,
				documents: new Set(),
				dialects: new Set(),
				dialectL1: new Set(),
				recordedYears: [],
				publishedYears: [],
				uris: new Set(),
				authors: new Set()
			};
			aggs.set(collection, a);
		}
		a.n += 1;
		if (rec.document) a.documents.add(String(rec.document));
		if (rec.dialect) a.dialects.add(String(rec.dialect));
		for (const d of (rec.dialect_lv1 as string[]) ?? []) a.dialectL1.add(d);
		if (rec.author) a.authors.add(String(rec.author));
		for (const ys of String(rec.recorded_at ?? '').match(/\d{4}/g) ?? []) {
			const yy = Number(ys);
			if (yy >= 1500 && yy <= 2100) a.recordedYears.push(yy);
		}
		for (const ys of String(rec.published_at ?? '').match(/\d{4}/g) ?? []) {
			const yy = Number(ys);
			if (yy >= 1500 && yy <= 2100) a.publishedYears.push(yy);
		}
		const uri = rec.uri as string | null;
		if (uri && /^https?:\/\//.test(uri) && a.uris.size < 5) a.uris.add(uri);
	}
	return aggs;
}

/**
 * Derive the engine `fields` map for one aggregated collection — byte-identical to
 * seed.ts's `seedCorpus` row build. Empty/null values are OMITTED (the engine skips
 * empties anyway; omitting avoids empty-overwrite noise). Returns the raw
 * authors/place-dialect/link inputs used for the entity graph.
 */
function deriveAgg(a: CorpusAgg): {
	fields: Record<string, unknown>;
	links: LinkInput[];
	authors: string[];
	placeDialect: string;
	titleEn: string | null;
} {
	const meta = CORPUS_META[a.collection];
	const region = a.dialectL1.has('北海道')
		? a.dialectL1.has('樺太')
			? 'other'
			: 'hokkaido'
		: a.dialectL1.has('樺太')
			? 'sakhalin'
			: '';
	// Prefer recording dates for chronology; fall back to publication only when
	// nothing was recorded — never mix the two into one span.
	const years = (a.recordedYears.length ? a.recordedYears : a.publishedYears).slice().sort(
		(x, y) => x - y
	);
	const yearStart = years.length ? years[0] : null;
	const yearEnd = years.length ? years[years.length - 1] : null;
	const dialectLabel = [...a.dialects].slice(0, 4).join('、');

	const fields: Record<string, unknown> = {
		title: a.collection,
		category: 'corpus',
		type: 'corpus-text',
		yearCertainty: yearStart ? (yearEnd && yearEnd !== yearStart ? 'range' : 'exact') : 'unknown',
		languages: ['ain', 'jpn'],
		scripts: ['latn', 'kana'],
		entryCount: a.n,
		entryCountLabel: 'sentences',
		summary: `アイヌ語・日本語対訳テキスト集。${a.n.toLocaleString('en-US')} 文 / ${a.documents.size.toLocaleString('en-US')} 資料。`
	};
	const titleEn = meta?.titleEn ?? null;
	if (titleEn) fields.titleEn = titleEn;
	if (a.authors.size === 1) fields.author = [...a.authors][0];
	if (yearStart) {
		fields.yearText = yearEnd && yearEnd !== yearStart ? `${yearStart}–${yearEnd}` : `${yearStart}`;
	}
	if (yearStart != null) fields.yearStart = yearStart;
	if (yearEnd != null && yearEnd !== yearStart) fields.yearEnd = yearEnd;
	if (dialectLabel) fields.dialect = dialectLabel;
	if (region) fields.region = region;

	// links + holding institution from the (≤5) URIs, in insertion order.
	const links: LinkInput[] = [];
	for (const uri of a.uris) {
		const host = uri.replace(/^https?:\/\//, '').split('/')[0];
		links.push({ type: linkTypeFor(host), url: uri, label: host });
	}

	return {
		fields,
		links,
		authors: [...a.authors],
		placeDialect: [...a.dialects].join(' ') + ' ' + [...a.dialectL1].join(' '),
		titleEn
	};
}

async function main() {
	if (!fs.existsSync(CORPUS_FILE)) {
		console.error(
			`✗ corpus file not found: ${CORPUS_FILE}\n  Set AINU_ROOT to the dir containing ainu-corpora/.`
		);
		process.exit(1);
	}

	console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}import:corpus → ${url!.split('?')[0]}  (streaming ${CORPUS_FILE})`);
	const aggs = await aggregate();
	// Deterministic emit order (Risk H) — sort collections by their originRecordId.
	// Per-collection field values are order-independent of this (each aggregate is
	// self-contained), so sorting only stabilises the run, never the projection.
	const collections = [...aggs.keys()].sort();
	const selected = LIMIT === Infinity ? collections : collections.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}aggregated ${collections.length} collections (${selected.length} selected)`
	);

	const db = openDb(url!, authToken);
	const runId = DRY_RUN
		? null
		: await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-corpus@1' });

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, other: 0 };

	for (const collection of selected) {
		const a = aggs.get(collection)!;
		seen.add(collection);
		const { fields, links, authors, placeDialect, titleEn } = deriveAgg(a);

		if (DRY_RUN) {
			console.log(
				`  ${collection}: ${a.n} sentences, ${Object.keys(fields).length} fields, ${links.length} links, ${authors.length} authors`
			);
			continue;
		}

		const input: MergeInput = {
			origin: ORIGIN,
			originRecordId: collection,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields,
			identifiers: [{ kind: 'repo_path', value: `${ORIGIN}:${collection}` }],
			links,
			presence: 'seen',
			runId,
			rawPayload: {
				collection,
				sentences: a.n,
				documents: a.documents.size,
				dialects: [...a.dialects].sort(),
				dialectL1: [...a.dialectL1].sort(),
				authors: [...a.authors].sort(),
				uris: [...a.uris].sort()
			}
		};

		const result = await emitSource(db, input, { provenanceRepo: ORIGIN, provenancePath: collection });
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

		// Holding institution(s) from the URI hosts — seed only re-attaches when the
		// slug differs from the previous URI's; the join is existence-checked anyway.
		let instAttached: string | null = null;
		for (const uri of a.uris) {
			const host = uri.replace(/^https?:\/\//, '').split('/')[0];
			const inst = INSTITUTIONS[host];
			if (inst && instAttached !== inst.slug) {
				await addInstitution(db, sid, inst, stamp, { role: 'holding' });
				instAttached = inst.slug;
			}
		}
		// Dialect places (role='dialect').
		await addPlaces(db, sid, placeDialect, stamp);
		// Corpus collections are Ainu-language (mostly oral-literature) text sets;
		// the credited contributors are speakers / narrators (話者).
		for (const au of authors) await addPersons(db, sid, au, stamp, 'speaker');
		// Topical/genre tags from the collection title (+ English title).
		await attachTags(db, sid, [a.collection, titleEn], stamp, TAG_DEFS);
	}

	let drifted = 0;
	if (!DRY_RUN) {
		drifted = await driftMissing(db, ORIGIN, seen, { derivation: DERIVATION, confidence: CONFIDENCE, runId });
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, collections: selected.length }
		});
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:corpus failed:', err);
		process.exit(1);
	});
