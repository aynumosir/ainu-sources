#!/usr/bin/env bun
/**
 * Feed #2 — Grammar bibliography (books + articles + presentations) importer (idempotent).
 *
 * The merge-engine replacement for seed.ts's `seedGrammar`. Walks
 * $AINU_ROOT/ainu-grammar/{books,articles,presentations} (the private repo's
 * dir/file names) and, for each record IN SEED ORDER (books → articles →
 * presentations, each in `readdirSync` order), derives the SAME fields seed.ts
 * did — byte-for-byte, reusing derive.ts (parseYear/hasCJK) and the identical
 * BOOK_TITLES table + scripts/data/ainu-grammar-links.json (AG_LINKS) — and
 * submits ONE `curated_assertion` observation per record through
 * mergeSourceObservation. The engine attaches to the existing source by its
 * `repo_path` (or DOI) identifier and emits value-hash noop claims (no duplicate
 * source), then this importer reconciles the author persons + topical tags and
 * set-union merges the public-alternative links idempotently.
 *
 * Origin        : 'ainu-grammar'
 * Idempotency key: (origin, originRecordId = provenancePath, contentHash) — the
 *                  engine's observation UNIQUE index. A re-run over unchanged
 *                  files is a dup-noop (zero projection change).
 * Identity key  : identifier repo_path = 'ainu-grammar:<provenancePath>' (matches the
 *                  bootstrap's `${repo}:${path}` form → repo_path_exact attach; the
 *                  normalizer lowercases it). A DOI (strong, from AG_LINKS) attaches
 *                  first when present.
 * Derivation    : curated_assertion @ 0.8 (≤ the bootstrap band, so it never clobbers
 *                  a bootstrapped/editorial value; noop-by-valueHash regardless).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run] [--limit N].
 *
 * Run:  AINU_ROOT=~/projects/Ainu bun run import:grammar
 *       DATABASE_URL=file:/tmp/clone.db bun run import:grammar --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseYear, hasCJK, detectScripts, TAG_DEFS } from './lib/derive';
import { openDb, addPersons, attachTags, type EntityStamp } from './lib/entities';
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
const GRAMMAR_DIR = path.join(AINU_ROOT, 'ainu-grammar');

const ORIGIN = 'ainu-grammar';
const DERIVATION = 'curated_assertion';
const CONFIDENCE = 0.8;

// Placeholder-titled famous books whose real title lives in seed.ts's BOOK_TITLES
// (a book dir is named YYYY_Author only, with no title). Byte-identical to seed.ts.
const BOOK_TITLES: Record<string, { title: string; titleEn: string | null }> = {
	'2022_Bugaeva': { title: 'Handbook of the Ainu Language', titleEn: 'Handbook of the Ainu Language' },
	'2008_Sato': { title: 'アイヌ語文法の基礎', titleEn: 'Foundations of Ainu Grammar' },
	'1936_Kindaichi': { title: 'アイヌ語法概説', titleEn: 'An Outline of Ainu Grammar' }
};

// Public alternatives for the (private) ainu-grammar imports, keyed by
// provenancePath (books/<dir> | articles/<base> | presentations/<base>). Same
// file seed.ts reads; `title`/`titleEn` fill the placeholder-titled books.
type AgLink = {
	title?: string;
	titleEn?: string;
	doi?: string | null;
	links?: { type: string; url: string; label?: string }[];
	source?: string;
};
const AG_LINKS_FILE = path.join(import.meta.dir, '..', 'data', 'ainu-grammar-links.json');
const AG_LINKS: Record<string, AgLink> = fs.existsSync(AG_LINKS_FILE)
	? JSON.parse(fs.readFileSync(AG_LINKS_FILE, 'utf8'))
	: {};

/**
 * Build the digital-access links for one record — byte-identical to seed.ts's
 * `attachAgLinks`. No AG_LINKS entry ⇒ zero links (matches the seed's early
 * return, so a source without a public alternative keeps only its bootstrapped
 * links). Otherwise a DOI link comes first, then the entry's `links`, deduped by
 * URL (an entry that carries both `doi` and a `type:"doi"` link to the same
 * doi.org URL emits one row). The engine set-unions these by (type,url), so an
 * ATTACH to a bootstrapped source finds them all and inserts nothing.
 */
function buildAgLinks(provenancePath: string, doi: string | null | undefined): LinkInput[] {
	const info = AG_LINKS[provenancePath];
	if (!info) return [];
	const out: LinkInput[] = [];
	const seen = new Set<string>();
	if (doi) {
		const url = `https://doi.org/${doi}`;
		seen.add(url);
		out.push({ type: 'doi', url, label: `doi:${doi}` });
	}
	for (const l of info.links ?? []) {
		if (seen.has(l.url)) continue;
		seen.add(l.url);
		out.push({ type: l.type, url: l.url, label: l.label ?? null });
	}
	return out;
}

/** Attach the numeric year fields only when present (byte-parity with the
 *  dictionaries importer's OMIT-empties rule — an unset year_end stays null on
 *  the historically-populated clone rather than being re-asserted empty). */
function withYear(fields: Record<string, unknown>, year: string): void {
	const y = parseYear(year);
	fields.yearCertainty = y.yearCertainty;
	if (y.yearText) fields.yearText = y.yearText;
	if (y.yearStart != null) fields.yearStart = y.yearStart;
	if (y.yearEnd != null) fields.yearEnd = y.yearEnd;
}

/** One derived grammar record — everything the engine + entity reconcile need. */
interface GrammarRecord {
	provenancePath: string;
	fields: Record<string, unknown>;
	/** raw author string for the person graph (addPersons splits/filters it) */
	author: string;
	/** texts swept against TAG_DEFS (title + the seed's literal type keyword) */
	tagTexts: (string | null | undefined)[];
	/** DOI (strong identifier) when AG_LINKS carries one */
	doi: string | null;
	links: LinkInput[];
}

/** Enumerate every grammar record IN SEED ORDER (books → articles → presentations). */
function collectRecords(): GrammarRecord[] {
	const records: GrammarRecord[] = [];

	// --- books (directories named YYYY_Author) ---
	const booksDir = path.join(GRAMMAR_DIR, 'books');
	if (fs.existsSync(booksDir)) {
		for (const dir of fs.readdirSync(booksDir)) {
			if (dir === 'ocr' || dir.startsWith('.')) continue;
			const full = path.join(booksDir, dir);
			if (!fs.statSync(full).isDirectory()) continue;
			const m = dir.match(/^(\d{4})_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw] = m;
			const author = authorRaw.replace(/([a-z])([A-Z])/g, '$1 $2');
			const known = BOOK_TITLES[dir];
			const provenancePath = `books/${dir}`;
			const ag = AG_LINKS[provenancePath];
			const doi = ag?.doi ?? null;
			const bookTitle = known?.title ?? ag?.title ?? `${author}（${year}）`;
			const bookTitleEn = known?.titleEn ?? ag?.titleEn ?? `${author} (${year})`;
			const fields: Record<string, unknown> = {
				title: bookTitle,
				titleEn: bookTitleEn,
				category: 'secondary',
				type: 'grammar',
				author,
				languages: ['ain'],
				// seed.ts's global post-pass (seed.ts:1815) overwrites the block's hardcoded
				// ['latn'] with detectScripts(title, titleEn) for EVERY source (title glyphs
				// are ground truth). Replicate the EFFECTIVE derivation so scripts (a
				// set_union field) is a value-noop on the enriched clone rather than adding
				// a stray 'latn' to a Japanese-titled work.
				scripts: detectScripts(bookTitle, bookTitleEn)
			};
			withYear(fields, year);
			records.push({ provenancePath, fields, author, tagTexts: [bookTitle, 'grammar'], doi, links: buildAgLinks(provenancePath, doi) });
		}
	}

	// --- articles + presentations (files YYYY_Author_Title.{pdf,ocr,md,txt}) ---
	for (const [sub, type] of [['articles', 'article'], ['presentations', 'presentation']] as const) {
		const dir = path.join(GRAMMAR_DIR, sub);
		if (!fs.existsSync(dir)) continue;
		const seen = new Set<string>();
		for (const file of fs.readdirSync(dir)) {
			if (file === 'ocr' || file === 'NAMING.md' || file.startsWith('.')) continue;
			const base = file.replace(/\.(pdf|ocr|md|txt)$/i, '');
			if (seen.has(base)) continue;
			seen.add(base);
			const m = base.match(/^(\d{4})_([^_]+)_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw, titleRaw] = m;
			const author = authorRaw.trim();
			const title = titleRaw.trim();
			const provenancePath = `${sub}/${base}`;
			const ag = AG_LINKS[provenancePath];
			const doi = ag?.doi ?? null;
			const isJa = hasCJK(title);
			const titleEn = isJa ? null : title; // seed: titleEn = isJa ? null : title
			const fields: Record<string, unknown> = {
				title,
				category: 'secondary',
				type,
				author,
				languages: isJa ? ['ain', 'jpn'] : ['ain', 'eng'],
				// EFFECTIVE scripts = seed.ts:1815 global detectScripts(title, titleEn) post-pass,
				// NOT the block's hardcoded ['latn'] (see the books branch).
				scripts: detectScripts(title, titleEn)
			};
			if (!isJa) fields.titleEn = title; // null ⇒ omitted (matches OMIT-empties rule)
			withYear(fields, year);
			// seed sweeps [title, <literal type keyword>]: 'grammar' for articles, 'presentation' for presentations
			const tagKeyword = type === 'article' ? 'grammar' : 'presentation';
			records.push({ provenancePath, fields, author, tagTexts: [title, tagKeyword], doi, links: buildAgLinks(provenancePath, doi) });
		}
	}

	return records;
}

async function main() {
	if (!fs.existsSync(GRAMMAR_DIR)) {
		console.error(`✗ grammar repo not found: ${GRAMMAR_DIR}\n  Set AINU_ROOT to the dir containing ainu-grammar/.`);
		process.exit(1);
	}
	const all = collectRecords();
	const records = LIMIT === Infinity ? all : all.slice(0, LIMIT);
	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}import:grammar → ${url!.split('?')[0]}  (${records.length}/${all.length} records)`
	);

	const db = openDb(url!, authToken);
	const runId = DRY_RUN ? null : await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-grammar@1' });

	const seen = new Set<string>();
	const stats = { applied: 0, noop: 0, other: 0 };

	for (const rec of records) {
		seen.add(rec.provenancePath);

		if (DRY_RUN) {
			console.log(`  ${rec.provenancePath}: ${Object.keys(rec.fields).length} fields, ${rec.links.length} links${rec.doi ? ', doi' : ''}`);
			continue;
		}

		const identifiers: MergeInput['identifiers'] = [
			{ kind: 'repo_path', value: `${ORIGIN}:${rec.provenancePath}` }
		];
		if (rec.doi) identifiers.push({ kind: 'doi', value: rec.doi });

		const input: MergeInput = {
			origin: ORIGIN,
			originRecordId: rec.provenancePath,
			derivation: DERIVATION,
			confidence: CONFIDENCE,
			evidence: 0,
			fields: rec.fields,
			identifiers,
			links: rec.links,
			presence: 'seen',
			runId,
			rawPayload: { provenancePath: rec.provenancePath, ...rec.fields }
		};

		const result = await emitSource(db, input, { provenanceRepo: ORIGIN, provenancePath: rec.provenancePath });
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
		await addPersons(db, sid, rec.author, stamp);
		await attachTags(db, sid, rec.tagTexts, stamp, TAG_DEFS);
	}

	let drifted = 0;
	if (!DRY_RUN) {
		drifted = await driftMissing(db, ORIGIN, seen, { derivation: DERIVATION, confidence: CONFIDENCE, runId });
		await closeRun(db, runId!, {
			status: 'completed',
			summary: { ...stats, drifted, records: records.length }
		});
	}

	console.log(
		`${DRY_RUN ? '[DRY-RUN] ' : ''}done: applied=${stats.applied} noop=${stats.noop} other=${stats.other} drifted-missing=${drifted}`
	);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('\n✗ import:grammar failed:', err);
		process.exit(1);
	});
