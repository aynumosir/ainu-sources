/**
 * ⚠️ RETIRED — legacy wipe-rebuild seed (formerly scripts/seed.ts).
 *
 * The idempotent, merge-engine seed is now `scripts/import-all.ts`
 * (`bun run seed`), which DELETES NOTHING. This script — a full domain-table
 * wipe + rebuild — is kept only for a confidence window behind the
 * ALLOW_LEGACY_WIPE=1 gate (its --plan / PLAN=1 read-only diff stays ungated).
 * Do NOT run it against production; prefer `bun run seed` / `bun run seed:plan`.
 * Reachable via `bun run seed:legacy-wipe` (still gated). Slated for deletion
 * once import-all has proven out on prod.
 *
 * Seeds the アイヌ語文献資料データベース from the sibling data repositories:
 *   - ../ainu-dictionaries/catalog.json   (dictionaries, wordlists, old documents)
 *   - ../ainu-grammar/{books,articles}     (secondary research literature)
 *   - ../ainu-corpora/data.jsonl           (aligned Ainu/Japanese corpus texts)
 *
 * Run:  ALLOW_LEGACY_WIPE=1 bun scripts/seed-legacy-wipe.ts   (reads DATABASE_URL from .env)
 *       bun scripts/seed-legacy-wipe.ts --plan                (read-only diff, ungated)
 *
 * Wipes the domain tables (NOT the auth tables) and rebuilds.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq, inArray } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as schema from '../src/lib/server/db/schema';
import {
	djb2,
	slugify,
	stripParens,
	isLatinTitle,
	decodeEntities,
	detectScripts,
	hasCJK,
	parseYear,
	GazEntry,
	regionFor,
	placesFor,
	InstEntry,
	INSTITUTIONS,
	linkTypeFor,
	PERSON_CANON,
	PERSON_ENRICH,
	canonicalSlugFor,
	splitNakaguro,
	KANA_KANJI,
	parsePersonName,
	TAG_DEFS,
	INSTITUTION_RE,
	isGarbageName,
	simplePersonKey,
	authorParts,
	geoSubjectText,
	CatalogEntry,
	langsForDict,
	CATALOG_OVERRIDES,
	CORPUS_META
} from './import/lib/derive';

const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(import.meta.dir, '../..');
const DICT_DIR = path.join(AINU_ROOT, 'ainu-dictionaries');
const GRAMMAR_DIR = path.join(AINU_ROOT, 'ainu-grammar');
const CORPUS_FILE = path.join(AINU_ROOT, 'ainu-corpora', 'data.jsonl');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const client = createClient({
	url,
	authToken: process.env.DATABASE_AUTH_TOKEN || undefined
});
const db = drizzle(client, { schema });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => crypto.randomUUID();




// ---------------------------------------------------------------------------
// In-memory accumulators
// ---------------------------------------------------------------------------
interface Row {
	[k: string]: unknown;
}
const sourceRows: Row[] = [];
const linkRows: Row[] = [];
const sourcePersonRows: Row[] = [];
const sourcePlaceRows: Row[] = [];
const sourceInstRows: Row[] = [];
const sourceTagRows: Row[] = [];
const sourceRelationRows: Row[] = [];

const personByKey = new Map<string, string>(); // key → id
const personById = new Map<string, Row>(); // id → row (for upgrade-on-merge)
const personRows: Row[] = [];
const usedPersonSlugs = new Set<string>();
const placeBySlug = new Map<string, string>();
const placeRows: Row[] = [];
const instBySlug = new Map<string, string>();
const instRows: Row[] = [];
const tagBySlug = new Map<string, string>();
const tagRows: Row[] = [];
const usedSlugs = new Set<string>();

function uniqueSlug(base: string): string {
	// Normalise the fully-assembled slug: a `${author}-${slugify(title).slice(0,50)}`
	// build can leave a trailing dash (the slice cuts mid-word) or a double dash.
	base = (base || '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
	let s = base || 'source';
	let n = 1;
	while (usedSlugs.has(s)) {
		n += 1;
		s = `${base}-${n}`;
	}
	usedSlugs.add(s);
	return s;
}


function getPerson(name: string): string {
	const parsed = parsePersonName(name);
	const display = parsed.name;
	const canon = canonicalSlugFor(name.trim()) ?? canonicalSlugFor(display);
	// Hand-verified enrichment (romaji / researchmap / wikidata), by canonical slug
	// first (most reliable), then by name forms (space-insensitive).
	const enrich =
		(canon ? PERSON_ENRICH[canon] : undefined) ??
		PERSON_ENRICH[name.trim()] ??
		PERSON_ENRICH[stripParens(display)] ??
		PERSON_ENRICH[stripParens(display).replace(/\s+/g, '')] ??
		PERSON_ENRICH[stripParens(name.trim()).replace(/\s+/g, '')];
	// Merge key: anyone with a known romaji keys on its DIACRITIC-FOLDED,
	// ORDER-INSENSITIVE romaji, so "Tomomi Satō" / "Sato Tomomi" / 佐藤知己 (and
	// kanji⇄Latin generally) collapse to one person. No-romaji kanji keys on the
	// despaced kanji; a plain Latin name without romaji on its alphanumerics.
	const romaji = enrich?.nameEn ?? parsed.nameEn;
	const foldRomaji = (s: string) =>
		s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean).sort().join(' ');
	const key = canon
		? `canon:${canon}`
		: romaji && !KANA_KANJI.test(romaji)
			? `r:${foldRomaji(romaji)}`
			: KANA_KANJI.test(display)
				? display.replace(/\s+/g, '')
				: display.toLowerCase().replace(/[^a-z0-9]/g, '');
	const researchmap: string | null = enrich?.researchmap ?? null;
	const wikidata: string | null = enrich?.wikidata ?? null;
	// Canonical display + romaji for this name form (canon form preferred).
	const c = canon ? PERSON_CANON[canon] : undefined;
	let pName = c ? c.name : display;
	let pNameEn: string | null = enrich?.nameEn ?? (c ? c.nameEn ?? (hasCJK(c.name) ? null : c.name) : parsed.nameEn);

	const existing = personByKey.get(key);
	if (existing) {
		// Merge: upgrade the kept person with anything better this form provides —
		// prefer a kanji display over a romanised one, and never lose a romaji or
		// researchmap/wikidata that only this form supplies.
		const row = personById.get(existing);
		if (row) {
			if (pName && KANA_KANJI.test(pName) && !KANA_KANJI.test(row.name as string)) row.name = pName;
			// prefer a curated (canon/enrich) romaji over a parsed Latin one
			if (enrich?.nameEn || c?.nameEn) row.nameEn = enrich?.nameEn ?? c?.nameEn;
			else if (!row.nameEn && pNameEn) row.nameEn = pNameEn;
			if (!row.researchmap && researchmap) row.researchmap = researchmap;
			if (!row.wikidata && wikidata) row.wikidata = wikidata;
		}
		return existing;
	}

	const id = uuid();
	let slug: string;
	if (canon) {
		slug = canon;
		usedPersonSlugs.add(slug);
	} else {
		// Prefer a readable slug from romaji (incl. enrichment) over a hash.
		const baseSlug =
			slugify(stripParens(display)) || (pNameEn ? slugify(pNameEn) : '') || `p-${djb2(display)}`;
		slug = baseSlug;
		let n = 1;
		while (usedPersonSlugs.has(slug)) {
			n += 1;
			slug = `${baseSlug}-${n}`;
		}
		usedPersonSlugs.add(slug);
	}

	personByKey.set(key, id);
	// Also index by the folded romaji, so a later Latin form (e.g. "Hideo Kirikae")
	// finds a person that was first created under a canon or kanji key.
	const idxRomaji = romaji ?? (canon ? PERSON_CANON[canon]?.nameEn : undefined);
	if (idxRomaji && !KANA_KANJI.test(idxRomaji)) {
		const rk = `r:${foldRomaji(idxRomaji)}`;
		if (!personByKey.has(rk)) personByKey.set(rk, id);
	}
	const row: Row = {
		id,
		slug,
		name: pName,
		nameEn: pNameEn,
		nameKana: null,
		nameAin: null,
		researchmap,
		wikidata
	};
	personRows.push(row);
	personById.set(id, row);
	return id;
}

function getPlace(p: GazEntry): string {
	const existing = placeBySlug.get(p.slug);
	if (existing) return existing;
	const id = uuid();
	placeBySlug.set(p.slug, id);
	placeRows.push({
		id,
		slug: p.slug,
		name: p.name,
		nameEn: p.nameEn,
		kind: p.kind,
		region: p.region,
		lat: p.lat,
		lng: p.lng
	});
	return id;
}

function getInstitution(inst: InstEntry): string {
	const existing = instBySlug.get(inst.slug);
	if (existing) return existing;
	const id = uuid();
	instBySlug.set(inst.slug, id);
	instRows.push({
		id,
		slug: inst.slug,
		name: inst.name,
		nameEn: inst.nameEn,
		country: inst.country,
		city: inst.city,
		lat: inst.lat,
		lng: inst.lng,
		url: inst.url
	});
	return id;
}


function getTag(def: (typeof TAG_DEFS)[number]): string {
	const existing = tagBySlug.get(def.slug);
	if (existing) return existing;
	const id = uuid();
	tagBySlug.set(def.slug, id);
	tagRows.push({ id, slug: def.slug, name: def.name, nameEn: def.nameEn, category: def.category });
	return id;
}

function attachTags(sourceId: string, ...texts: (string | null | undefined)[]) {
	const hay = texts.filter(Boolean).join(' ');
	for (const def of TAG_DEFS) {
		if (def.match.test(hay)) {
			sourceTagRows.push({ id: uuid(), sourceId, tagId: getTag(def) });
		}
	}
}

function pushTagBySlug(sourceId: string, slug: string) {
	const def = TAG_DEFS.find((d) => d.slug === slug);
	if (def) sourceTagRows.push({ id: uuid(), sourceId, tagId: getTag(def) });
}

// Journal/series names are a strong topical signal but need guarding: the
// アイヌ語地名研究 journal ⇒ placenames, but its 月報 newsletter (forewords/memoirs)
// is not; 口承文芸-family venues ⇒ oral-literature. (seed-level dedup drops any
// overlap with the title-based sweep.)
function attachVenueTags(sourceId: string, venue: string | null | undefined) {
	if (!venue) return;
	if (/地名/.test(venue) && !/月報/.test(venue)) pushTagBySlug(sourceId, 'placenames');
	if (/口承文[芸藝]|口頭文芸|説話文学|説話・伝承学/.test(venue)) pushTagBySlug(sourceId, 'oral-literature');
}

function addPersons(sourceId: string, author: string | null | undefined, role = 'author') {
	if (!author) return;
	const cleaned = author.trim();
	if (!cleaned || /^(unknown|anon\.?|anonymous|不明|作者不詳|なし|n\/a)$/i.test(cleaned)) return;
	// Placeholder "authorship" labels are not people — keep them only as the
	// source's free-text author, never as a person entity.
	if (/\b(various|compilation)\b/i.test(cleaned)) return;
	const parts = cleaned
		.split(/\s*[&;|｜/／]\s*|、|，|\s+and\s+/) // ｜/| = co-author separators in the source data
		.flatMap(splitNakaguro)
		.map((s) => s.trim())
		.filter(Boolean);
	let i = 0;
	for (const name of parts) {
		// Organisations credited as contributors (e.g. 「タネ・プロジェクト (協力:…)」)
		// are not people — keep them out of the person graph.
		if (INSTITUTION_RE.test(name)) continue;
		sourcePersonRows.push({ id: uuid(), sourceId, personId: getPerson(name), role, sortOrder: i++ });
	}
}

// Academic authors become person entities only above a prominence threshold, so
// /people stays curated (long-tail one-off authors remain free-text). Institutions
// masquerading as authors are excluded.
function addPersonsGated(sourceId: string, authors: string[], allow: Set<string>, role = 'author') {
	let i = 0;
	for (const a of authors)
		for (const name of authorParts(a)) {
			// Link prominent authors (threshold) OR anyone with a known alias/canon
			// (so 安岡孝一's Qiita/HF handle "KoichiYasuoka" attaches to his person).
			if (INSTITUTION_RE.test(name) || isGarbageName(name) || (!allow.has(simplePersonKey(name)) && !canonicalSlugFor(name))) continue;
			sourcePersonRows.push({ id: uuid(), sourceId, personId: getPerson(name), role, sortOrder: i++ });
		}
}

function addPlaces(sourceId: string, dialect: string | null | undefined, role = 'dialect') {
	if (!dialect) return;
	for (const p of placesFor(dialect)) {
		sourcePlaceRows.push({ id: uuid(), sourceId, placeId: getPlace(p), role });
	}
}


// ---------------------------------------------------------------------------
// 1) Dictionaries / wordlists / old documents
// ---------------------------------------------------------------------------

function seedDictionaries() {
	const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(path.join(DICT_DIR, 'catalog.json'), 'utf8'));
	for (const e of catalog) {
		const id = uuid();
		const slug = uniqueSlug(slugify(e.source_dir));
		const ov = CATALOG_OVERRIDES[e.source_dir];
		const y = parseYear(ov?.year ?? e.year);
		const base = langsForDict(e);
		const languages = ov?.languages ?? base.languages;
		const scripts = ov?.scripts ?? base.scripts;
		const author = ov?.author ?? e.author;
		const dialect = e.dialect || '';
		sourceRows.push({
			id,
			slug,
			title: e.title,
			titleEn: e.title_en ?? null,
			category: 'primary',
			type: e.type,
			author: author && !/^unknown$/i.test(author) ? author : null,
			...y,
			dialect: dialect || null,
			region: regionFor(dialect) || null,
			languages,
			scripts,
			entryCount: e.rows ?? null,
			entryCountLabel: 'entries',
			license: e.license ?? null,
			provenanceRepo: 'ainu-dictionaries',
			provenancePath: e.source_dir,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		addPersons(id, author);
		addPlaces(id, dialect);
		attachTags(id, e.title, e.title_en, e.type, dialect);
	}
	return catalog.length;
}

// ---------------------------------------------------------------------------
// 2) Grammar bibliography (books + articles)
// ---------------------------------------------------------------------------
const BOOK_TITLES: Record<string, { title: string; titleEn: string | null }> = {
	'2022_Bugaeva': { title: 'Handbook of the Ainu Language', titleEn: 'Handbook of the Ainu Language' },
	'2008_Sato': { title: 'アイヌ語文法の基礎', titleEn: 'Foundations of Ainu Grammar' },
	'1936_Kindaichi': { title: 'アイヌ語法概説', titleEn: 'An Outline of Ainu Grammar' }
};

// Public alternatives for the ainu-grammar imports (the repo is private). Keyed
// by provenancePath (books/<dir> | articles/<base>); every link was verified to
// resolve to the matching work (CiNii by-title pass + web research, author+year+
// title checked). `title`/`titleEn` fill the placeholder-titled famous books.
// See scripts/enrich-ainu-grammar.ts. Survives reseed.
type AgLink = {
	title?: string;
	titleEn?: string;
	doi?: string | null;
	links?: { type: string; url: string; label?: string }[];
	source?: string;
};
const AG_LINKS_FILE = path.join(import.meta.dir, 'data', 'ainu-grammar-links.json');
const AG_LINKS: Record<string, AgLink> = fs.existsSync(AG_LINKS_FILE)
	? JSON.parse(fs.readFileSync(AG_LINKS_FILE, 'utf8'))
	: {};
function attachAgLinks(sourceId: string, provenancePath: string, doi: string | null | undefined) {
	const info = AG_LINKS[provenancePath];
	if (!info) return;
	let so = 0;
	// Dedup by URL: some AG_LINKS entries carry both a `doi` field and a
	// `type:"doi"` link to the same doi.org URL (e.g. books/1912_Pilsudski),
	// which would otherwise emit two identical rows.
	const seen = new Set<string>();
	if (doi) {
		const url = `https://doi.org/${doi}`;
		seen.add(url);
		linkRows.push({ id: uuid(), sourceId, type: 'doi', label: `doi:${doi}`, url, sortOrder: so++ });
	}
	for (const l of info.links ?? []) {
		if (seen.has(l.url)) continue;
		seen.add(l.url);
		linkRows.push({ id: uuid(), sourceId, type: l.type, label: l.label ?? null, url: l.url, sortOrder: so++ });
	}
}

function seedGrammar() {
	let count = 0;
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
			const id = uuid();
			const slug = uniqueSlug(slugify(dir));
			const bookTitle = known?.title ?? ag?.title ?? `${author}（${year}）`;
			sourceRows.push({
				id,
				slug,
				title: bookTitle,
				titleEn: known?.titleEn ?? ag?.titleEn ?? `${author} (${year})`,
				category: 'secondary',
				type: 'grammar',
				author,
				...parseYear(year),
				languages: ['ain'],
				scripts: ['latn'],
				license: null,
				provenanceRepo: 'ainu-grammar',
				provenancePath,
				externalIds: ag?.doi ? { doi: ag.doi } : null,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			addPersons(id, author, 'author');
			attachTags(id, bookTitle, 'grammar');
			attachAgLinks(id, provenancePath, ag?.doi);
			count += 1;
		}
	}
	// --- articles (files YYYY_Author_Title.{pdf,ocr,md}) ---
	const artDir = path.join(GRAMMAR_DIR, 'articles');
	if (fs.existsSync(artDir)) {
		const seen = new Set<string>();
		for (const file of fs.readdirSync(artDir)) {
			if (file === 'ocr' || file === 'NAMING.md' || file.startsWith('.')) continue;
			const base = file.replace(/\.(pdf|ocr|md|txt)$/i, '');
			if (seen.has(base)) continue;
			seen.add(base);
			const m = base.match(/^(\d{4})_([^_]+)_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw, titleRaw] = m;
			const author = authorRaw.trim();
			const title = titleRaw.trim();
			const provenancePath = `articles/${base}`;
			const ag = AG_LINKS[provenancePath];
			const id = uuid();
			const slug = uniqueSlug(`${year}-${slugify(author) || 'x'}-${slugify(title) || djb2(base)}`);
			const isJa = hasCJK(title);
			sourceRows.push({
				id,
				slug,
				title,
				titleEn: isJa ? null : title,
				category: 'secondary',
				type: 'article',
				author,
				...parseYear(year),
				languages: isJa ? ['ain', 'jpn'] : ['ain', 'eng'],
				scripts: ['latn'],
				license: null,
				provenanceRepo: 'ainu-grammar',
				provenancePath,
				externalIds: ag?.doi ? { doi: ag.doi } : null,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			addPersons(id, author, 'author');
			attachTags(id, title, 'grammar');
			attachAgLinks(id, provenancePath, ag?.doi);
			count += 1;
		}
	}
	// --- presentations (conference talks/posters; files YYYY_Author_Title.{pdf,ocr}) ---
	const presDir = path.join(GRAMMAR_DIR, 'presentations');
	if (fs.existsSync(presDir)) {
		const seen = new Set<string>();
		for (const file of fs.readdirSync(presDir)) {
			if (file === 'ocr' || file === 'NAMING.md' || file.startsWith('.')) continue;
			const base = file.replace(/\.(pdf|ocr|md|txt)$/i, '');
			if (seen.has(base)) continue;
			seen.add(base);
			const m = base.match(/^(\d{4})_([^_]+)_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw, titleRaw] = m;
			const author = authorRaw.trim();
			const title = titleRaw.trim();
			const provenancePath = `presentations/${base}`;
			const ag = AG_LINKS[provenancePath];
			const id = uuid();
			const slug = uniqueSlug(`${year}-${slugify(author) || 'x'}-${slugify(title) || djb2(base)}`);
			const isJa = hasCJK(title);
			sourceRows.push({
				id,
				slug,
				title,
				titleEn: isJa ? null : title,
				category: 'secondary',
				type: 'presentation',
				author,
				...parseYear(year),
				languages: isJa ? ['ain', 'jpn'] : ['ain', 'eng'],
				scripts: ['latn'],
				license: null,
				provenanceRepo: 'ainu-grammar',
				provenancePath,
				externalIds: ag?.doi ? { doi: ag.doi } : null,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			addPersons(id, author, 'author');
			attachTags(id, title, 'presentation');
			attachAgLinks(id, provenancePath, ag?.doi);
			count += 1;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// 3) Corpus collections (aggregate data.jsonl by collection_lv1)
// ---------------------------------------------------------------------------
// CORPUS_META lives in ./import/lib/derive (single source of truth shared with
// the corpus importer) so both derive byte-identical slug/titleEn values.

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

async function seedCorpus(): Promise<number> {
	if (!fs.existsSync(CORPUS_FILE)) {
		console.warn(`! corpus file not found at ${CORPUS_FILE} — skipping corpus`);
		return 0;
	}
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

	let count = 0;
	for (const a of aggs.values()) {
		const id = uuid();
		const meta = CORPUS_META[a.collection];
		const slug = uniqueSlug(meta?.slug ?? `corpus-${djb2(a.collection)}`);
		const region = a.dialectL1.has('北海道')
			? a.dialectL1.has('樺太')
				? 'other'
				: 'hokkaido'
			: a.dialectL1.has('樺太')
				? 'sakhalin'
				: '';
		// Prefer recording dates for chronology; fall back to publication only when
		// nothing was recorded — never mix the two into one span.
		const years = (a.recordedYears.length ? a.recordedYears : a.publishedYears).sort(
			(x, y) => x - y
		);
		const yearStart = years.length ? years[0] : null;
		const yearEnd = years.length ? years[years.length - 1] : null;
		const dialectLabel = [...a.dialects].slice(0, 4).join('、');
		sourceRows.push({
			id,
			slug,
			title: a.collection,
			titleEn: meta?.titleEn ?? null,
			category: 'corpus',
			type: 'corpus-text',
			author: a.authors.size === 1 ? [...a.authors][0] : null,
			yearText: yearStart ? (yearEnd && yearEnd !== yearStart ? `${yearStart}–${yearEnd}` : `${yearStart}`) : '',
			yearStart,
			yearEnd: yearEnd !== yearStart ? yearEnd : null,
			yearCertainty: yearStart ? (yearEnd && yearEnd !== yearStart ? 'range' : 'exact') : 'unknown',
			dialect: dialectLabel || null,
			region: region || null,
			languages: ['ain', 'jpn'],
			scripts: ['latn', 'kana'],
			entryCount: a.n,
			entryCountLabel: 'sentences',
			summary: `アイヌ語・日本語対訳テキスト集。${a.n.toLocaleString('en-US')} 文 / ${a.documents.size.toLocaleString('en-US')} 資料。`,
			provenanceRepo: 'ainu-corpora',
			provenancePath: a.collection,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		// links + holding institution from URIs
		let sortOrder = 0;
		let instAttached: string | null = null;
		for (const uri of a.uris) {
			const host = uri.replace(/^https?:\/\//, '').split('/')[0];
			linkRows.push({
				id: uuid(),
				sourceId: id,
				type: linkTypeFor(host),
				label: host,
				url: uri,
				sortOrder: sortOrder++
			});
			const inst = INSTITUTIONS[host];
			if (inst && instAttached !== inst.slug) {
				sourceInstRows.push({ id: uuid(), sourceId: id, institutionId: getInstitution(inst), role: 'holding' });
				instAttached = inst.slug;
			}
		}
		addPlaces(id, [...a.dialects].join(' ') + ' ' + [...a.dialectL1].join(' '));
		// Corpus collections are Ainu-language (mostly oral-literature) text sets;
		// the credited contributors are speakers / narrators (話者).
		for (const au of a.authors) addPersons(id, au, 'speaker');
		attachTags(id, a.collection, meta?.titleEn);
		count += 1;
	}
	return count;
}

// ---------------------------------------------------------------------------
// 4) Manual sources — modern tools, resources & media (the aynu.org ecosystem)
//
// Hand-curated, all verifiable at the listed URLs. Kept here (not in a sibling
// repo) so they survive a re-seed. provenanceRepo = 'manual'.
//
// ⚠ BANNED: never add YouTube channel UCb6agoDa9ujg0412JpeWdbg (AI-generated
//   content, unsuitable for a scholarly index).
// ---------------------------------------------------------------------------
interface ManualSource {
	slug: string;
	title: string;
	titleEn: string;
	type: string;
	category?: string; // defaults to 'tool'
	author?: string;
	languages: string[];
	scripts?: string[];
	yearStart?: number;
	summary: string;
	links: { type: string; url: string; label?: string }[];
}

const MANUAL_SOURCES: ManualSource[] = [
	{
		slug: 'aynuwiki',
		title: 'Aynuwiki',
		titleEn: 'Aynuwiki',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語・アイヌ文化に関する協同編集のウィキ。',
		links: [{ type: 'website', url: 'https://wiki.aynu.org/', label: 'wiki.aynu.org' }]
	},
	{
		slug: 'ukosamaani-sait',
		title: 'Ukosamaani Sait',
		titleEn: 'Ukosamaani Sait',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語のツール・リソースを集めたポータルサイト。',
		links: [{ type: 'website', url: 'https://site.aynu.org/', label: 'site.aynu.org' }]
	},
	{
		slug: 'poro-cinumkekampi',
		title: 'Poro Cinumkekampi',
		titleEn: 'Poro Cinumkekampi (online dictionary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'オンラインのアイヌ語辞典。',
		links: [{ type: 'website', url: 'https://dict.aynu.org/', label: 'dict.aynu.org' }]
	},
	{
		slug: 'itak-uoeroskip',
		title: 'Itak-uoeroskip',
		titleEn: 'Itak-uoeroskip (terminology glossary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の用語集（言語学・文法用語などの対訳）。',
		links: [{ type: 'website', url: 'https://itak.aynu.org/', label: 'itak.aynu.org' }]
	},
	{
		slug: 'aynu-itah',
		title: 'Айну-Итах',
		titleEn: 'Ajnu-Itah (Russian–Ainu resource)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'rus'],
		scripts: ['latn', 'cyrl'],
		summary: 'ロシア語によるアイヌ語の辞書・資料。',
		links: [{ type: 'website', url: 'https://itah.aynu.org/', label: 'itah.aynu.org' }]
	},
	{
		slug: 'tu-itak-re-itak',
		title: 'tu itak re itak',
		titleEn: 'tu itak re itak (quiz)',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の学習クイズ。',
		links: [{ type: 'website', url: 'https://quiz.aynu.org/', label: 'quiz.aynu.org' }]
	},
	{
		slug: 'ainu-mcp',
		title: 'ainu-mcp',
		titleEn: 'ainu-mcp (Model Context Protocol server)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn', 'eng'],
		summary: 'アイヌ語の辞書・コーパス・文法を統合する Model Context Protocol サーバー。',
		links: [{ type: 'website', url: 'https://mcp.aynu.org/', label: 'mcp.aynu.org' }]
	},
	{
		slug: 'kampisos',
		title: 'Kampisos',
		titleEn: 'Kampisos (corpus search)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: '検索・絞り込み機能付きのアイヌ語コーパス（170万語以上）。',
		links: [{ type: 'website', url: 'https://kampisos.aynu.io/', label: 'kampisos.aynu.io' }]
	},
	{
		slug: 'tunci',
		title: 'Tunci',
		titleEn: 'Tunci (machine translation)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の機械翻訳ツール。',
		links: [{ type: 'website', url: 'https://tunci.aynu.io/', label: 'tunci.aynu.io' }]
	},
	{
		slug: 'minecraft-ainu',
		title: 'minecraft-ainu',
		titleEn: 'minecraft-ainu (resource pack)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'Minecraft をアイヌ語化するリソースパック。',
		links: [
			{ type: 'github', url: 'https://github.com/aynumosir/minecraft-ainu', label: 'GitHub' }
		]
	},
	{
		slug: 'ainconv',
		title: 'ainconv',
		titleEn: 'ainconv (script conversion library)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		scripts: ['latn', 'kana', 'cyrl'],
		summary: 'アイヌ語表記（ラテン文字・カナ・キリル文字）を相互変換するライブラリ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	},
	{
		slug: 'ainu-utils',
		title: 'ainu-utils',
		titleEn: 'ainu-utils (processing utilities)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'アイヌ語テキスト処理ユーティリティ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	}
];

// Video / animation sources (type: 'video', category: 'corpus').
// NOTE: サクアニメ entries go here once the exact channel/playlist URL is
// confirmed. The banned channel (see top of section) must never be listed.
const MANUAL_VIDEOS: ManualSource[] = [];

function seedManual(): number {
	const all = [...MANUAL_SOURCES, ...MANUAL_VIDEOS];
	for (const m of all) {
		const id = uuid();
		const slug = uniqueSlug(m.slug);
		sourceRows.push({
			id,
			slug,
			title: m.title,
			titleEn: m.titleEn,
			category: m.category ?? 'tool',
			type: m.type,
			author: m.author ?? null,
			yearText: m.yearStart ? `${m.yearStart}` : '',
			yearStart: m.yearStart ?? null,
			yearEnd: null,
			yearCertainty: m.yearStart ? 'exact' : 'unknown',
			languages: m.languages,
			scripts: m.scripts ?? ['latn'],
			summary: m.summary,
			provenanceRepo: 'manual',
			provenancePath: m.slug,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		let sortOrder = 0;
		for (const l of m.links) {
			linkRows.push({
				id: uuid(),
				sourceId: id,
				type: l.type,
				label: l.label ?? null,
				url: l.url,
				sortOrder: sortOrder++
			});
		}
		attachTags(id, m.title, m.titleEn, m.type);
	}
	return all.length;
}

// ---------------------------------------------------------------------------
// 5) Academic index — Ainu *linguistics* literature collected from open
// repositories (OpenAlex, …) by scripts/collect-academic.ts. Ingested as
// `secondary` sources, deduped by DOI and normalized title against everything
// already loaded (esp. the ainu-grammar bibliography).
// ---------------------------------------------------------------------------
const ACADEMIC_FILE = path.join(import.meta.dir, 'data', 'academic-index.json');
const CITATION_EDGES_FILE = path.join(import.meta.dir, 'data', 'citation-edges.json');

const META_LANG: Record<string, string> = {
	// Accept both 2-letter (CiNii/Crossref) and 3-letter (researchmap codes `jpn`,
	// 501 records) language tags — else 3-letter ones fall through to null and the
	// work gets mis-tagged languages:['ain'] + scripts:['latn'].
	en: 'eng', eng: 'eng', ja: 'jpn', jpn: 'jpn', ru: 'rus', rus: 'rus',
	de: 'deu', deu: 'deu', fr: 'fra', fra: 'fra', es: 'spa', spa: 'spa',
	it: 'ita', ita: 'ita', pl: 'pol', pol: 'pol', ko: 'kor', kor: 'kor',
	zh: 'zho', zho: 'zho', nl: 'nld', nld: 'nld', la: 'lat', lat: 'lat'
};

function normTitle(s: string): string {
	return (s || '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		// Keep Latin, kana, Han, Cyrillic AND Hangul (NFKD decomposes Korean
		// syllables to conjoining jamo U+1100–U+11FF) — else Korean/Russian titles
		// normalize to '' and either collapse on dedup or get dropped at seed.
		.replace(/[^a-z0-9぀-ヿ一-龯Ѐ-ӿᄀ-ᇿ가-힣]+/g, '')
		.trim();
}

// Fuzzy work-key for matching a digitised witness to its catalogued original:
// drop （holding library） parens and trailing volume markers (乾/坤/上/下/巻/冊…).
function coreKey(s: string): string {
	const stripped = (s || '')
		.replace(/[（(][^）)]*[)）]/g, '')
		.replace(/[\s　]+/g, '')
		.replace(/(乾巻|坤巻|乾|坤|上巻|下巻|上|下|前編|後編|[全]?[一二三四五六七八九十百\d]+巻|巻[上中下一二三四五六七八九十\d]*|[一二三四五六七八九十\d]+冊|第[一二三四五六七八九十\d]+冊?)$/u, '');
	return normTitle(stripped);
}

// Categorisation review: derive a proper {category, type} for an imported record
// instead of the crude grammar-book/grammar-article binary. Honours collector-set
// tool/primary categories; refines secondary papers by title.
function classifyAcademic(rec: {
	title: string;
	type: string;
	category?: string;
	source?: string;
	rawType?: string;
}): { category: string; type: string } {
	const t = rec.title || '';
	// Digital resources
	if (rec.source === 'huggingface')
		return rec.rawType === 'hf-dataset'
			? { category: 'corpus', type: 'dataset' } // a folklore/translation dataset IS corpus data
			: { category: 'tool', type: 'model' };
	if (rec.source === 'qiita' || rec.source === 'note')
		return { category: 'tool', type: 'web-article' }; // blog post, distinct from a published article
	if (rec.category === 'tool') return { category: 'tool', type: rec.type };
	// Primary Edo materials: a vocabulary keeps its lexicographic form; else a document
	if (rec.category === 'primary') {
		if (/藻汐草|語箋|語集|蝦夷語|方言|単語|語彙|詞|言葉|ことば|辞書|辞典/.test(t))
			return { category: 'primary', type: 'wordlist' };
		return { category: 'primary', type: 'old-document' };
	}
	if (/コーパス|corpus|テキスト集|用例集/i.test(t)) return { category: 'corpus', type: 'corpus-text' };
	// Normalise the incoming form (handles indexes built before the grammar-* rename)
	const baseType =
		rec.type === 'grammar-book' ? 'book' : rec.type === 'grammar-article' ? 'article' : rec.type;
	// Secondary literature, by bibliographic FORM (subject is captured by tags)
	let type = 'article';
	if (/辞典|辞書|字典|事典|辭典|dictionary|lexicon|和愛|愛和/i.test(t)) type = 'dictionary';
	else if (/語彙集|単語集|wordlist|vocabular/i.test(t)) type = 'wordlist';
	else if (/文献目録|書誌|bibliograph/i.test(t)) type = 'bibliography';
	else if (/博士論文|修士論文|学位論文|dissertation|\bph\.?\s?d\b|doctoral thesis/i.test(t)) type = 'thesis';
	else if (/(アイヌ語|ainu)[^。]{0,8}(文法|文典|grammar)|grammar of|文法書/i.test(t)) type = 'grammar';
	else if (baseType === 'thesis') type = 'thesis';
	else if (
		baseType === 'book' ||
		/入門|教材|テキスト|叢書|全集|ハンドブック|handbook|introduction|読本|講座/i.test(t)
	)
		type = 'book';
	return { category: 'secondary', type };
}

// Script(s) for an imported academic record. Japanese/Chinese titles are written
// in kanji(+kana), Russian in Cyrillic; romanised studies stay Latin.
function scriptsForAcademic(title: string, metalang: string | null): string[] {
	// Base the writing system on the WORK's language, not on whether its (often
	// bilingual) title happens to contain kanji — else an English paper with a
	// Japanese subtitle gets mis-tagged kanji/kana.
	if (metalang === 'rus') return ['cyrl'];
	if (metalang === 'jpn') return ['kanji', 'kana'];
	if (metalang === 'zho' || metalang === 'lzh') return ['kanji'];
	return ['latn']; // eng/deu/fra/ita/lat/spa/pol/nld/kor & romanised Ainu
}

// Author corrections for records where OpenAlex/Crossref/JSTOR conflated a book's
// *reviewer* (or a missing co-author) with its real author. Keyed by DOI, else by
// "<source>:<externalId>". Replacing rec.authors fixes the free-form string, the
// normalized person links, AND the slug in one place. (Verified case-by-case:
// Street & Grim are reviewers of Refsing's grammar / Ohnuki-Tierney's book; Teeter
// & de Graaf are genuine co-authors the normalized list was missing.)
const AUTHOR_OVERRIDES: Record<string, string[]> = {
	'10.2307/489315': ['Kirsten Refsing'], // John C. Street was the reviewer
	'10.2307/1178372': ['Emiko Ohnuki‐Tierney'], // John A. Grim was the reviewer
	'10.46538/hlj.8.2.5': ['Jennifer Teeter', 'Takayuki Okazaki'], // Teeter co-authored (lead)
	'openalex:W2576849698': ['Tjeerd de Graaf', 'Hidetoshi Shiraishi'] // de Graaf co-authored (lead)
};

// Reprint/later-edition records whose year_start was harvested as the REPRINT
// year, so earlier works that cite the original appear to cite the future. Keyed
// by DOI, else "<source>:<externalId>"; the value is the ORIGINAL publication year.
const SOURCE_YEAR_OVERRIDES: Record<string, number> = {
	'openalex:W1498959860': 1905, // Batchelor, Ainu-English-Japanese Dictionary (repr. 2010; orig. 1889/1905)
	'openalex:W1571539709': 1912, // Piłsudski, Materials for the Study of the Ainu Language (repr. 2004; orig. 1912)
	'10.1515/9783110895681': 1912
};

function seedAcademic(): { added: number; skipped: number; cites: number } {
	if (!fs.existsSync(ACADEMIC_FILE)) {
		console.warn(`! academic index not found at ${ACADEMIC_FILE} — run collect-academic.ts; skipping`);
		return { added: 0, skipped: 0, cites: 0 };
	}
	interface Rec {
		source: string; externalId: string; doi: string | null; title: string;
		year: number | null; type: string; language: string | null;
		authors: string[]; venue: string | null; url: string | null; pdf: string | null;
		category?: string; rawType?: string;
		links?: { type: string; url: string; label?: string | null }[];
	}
	const records: Rec[] = JSON.parse(fs.readFileSync(ACADEMIC_FILE, 'utf8'));

	// Prominence pre-pass: an author is promoted to a person entity only with ≥3
	// works in the index (keeps /people curated; merging/researchmap come via
	// getPerson/PERSON_ENRICH). Counted on a space/comma-insensitive key.
	const AUTHOR_MIN_WORKS = 2;
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
	const prominentAuthors = new Set([...authorCount].filter(([, n]) => n >= AUTHOR_MIN_WORKS).map(([k]) => k));
	// Verified author-override names are correct by construction, so promote them
	// past the "prominent enough" gate — otherwise a genuine but low-frequency
	// co-author (Teeter, de Graaf) would be dropped from the normalized links.
	for (const names of Object.values(AUTHOR_OVERRIDES))
		for (const a of names)
			for (const part of authorParts(a)) {
				const k = simplePersonKey(part);
				if (k) prominentAuthors.add(k);
			}

	// Dedup + enrichment indexes from everything already loaded. On a collision we
	// don't merely drop the record — if it carries typed `links` (a Honkoku
	// transcription, a Kokusho IIIF manifest…) we graft those onto the existing
	// source, so a digitisation of a book we already hold becomes a resource ON
	// that book. Records with links also match by a fuzzy `coreKey` (volume- and
	// holding-suffix-stripped) so 「藻汐草　乾巻」 lands on 「蝦夷方言藻汐草」.
	const idByTitle = new Map<string, string>();
	const idByDoi = new Map<string, string>();
	const idByCore = new Map<string, string>();
	const linkSeen = new Set<string>();
	for (const r of sourceRows) {
		const t = normTitle(r.title as string);
		if (t) { idByTitle.set(t, r.id as string); idByCore.set(coreKey(r.title as string), r.id as string); }
		if (r.titleEn) { const te = normTitle(r.titleEn as string); if (te) idByTitle.set(te, r.id as string); }
		const ext = r.externalIds as Record<string, string> | undefined;
		if (ext?.doi) idByDoi.set(ext.doi.toLowerCase(), r.id as string);
	}
	for (const l of linkRows) linkSeen.add(`${l.sourceId}\t${l.url}`);

	const addLink = (sourceId: string, type: string, url: string | null | undefined, label: string | null | undefined, so: number) => {
		if (!url) return;
		const k = `${sourceId}\t${url}`;
		if (linkSeen.has(k)) return;
		linkSeen.add(k);
		linkRows.push({ id: uuid(), sourceId, type, label: label ?? null, url, sortOrder: so });
	};

	// OpenAlex work id → the source it ended up as (whether freshly inserted or
	// merged into an earlier record). Lets us rebuild the citation graph below.
	const oaToSource = new Map<string, string>();

	let added = 0;
	let enriched = 0;
	let skipped = 0;
	for (const rec of records) {
		// Strip HTML markup that Crossref/CiNii embed in titles (<i>/<b>/<scp>/<sub>…)
		// — it renders as literal tags and is ugly/unsafe. Decode common entities too.
		if (rec.title)
			rec.title = decodeEntities(rec.title)
				.replace(/<\/?(b|i|em|strong|sub|sup|scp|sc|inf|span|u|tt|small|var|mml:[a-z]+)\b[^>]*>/gi, '')
				.replace(/\s+/g, ' ')
				.trim();
		const nt = normTitle(rec.title);
		const doi = rec.doi?.toLowerCase() ?? null;
		const override = AUTHOR_OVERRIDES[doi ?? ''] ?? AUTHOR_OVERRIDES[`${rec.source}:${rec.externalId}`];
		if (override) rec.authors = override;
		const hasLinks = !!(rec.links?.length || rec.pdf);
		const existingId =
			(doi ? idByDoi.get(doi) : undefined) ??
			(nt ? idByTitle.get(nt) : undefined) ??
			(hasLinks ? idByCore.get(coreKey(rec.title)) : undefined); // fuzzy only when there's something to graft
		if (rec.source === 'openalex' && existingId) oaToSource.set(rec.externalId, existingId);
		if (!nt || existingId) {
			if (existingId && hasLinks) {
				let so = 50;
				for (const l of rec.links ?? []) addLink(existingId, l.type, l.url, l.label, so++);
				if (rec.pdf) addLink(existingId, 'pdf', rec.pdf, 'Open access PDF', so++);
				enriched += 1;
			}
			skipped += 1;
			continue;
		}

		const id = uuid();
		// Correct reprint records that carry the reprint year as year_start, which
		// makes earlier works appear to "cite the future" (see SOURCE_YEAR_OVERRIDES).
		const yearOv = SOURCE_YEAR_OVERRIDES[doi ?? ''] ?? SOURCE_YEAR_OVERRIDES[`${rec.source}:${rec.externalId}`];
		if (yearOv != null) rec.year = yearOv;
		const y = parseYear(rec.year != null ? String(rec.year) : '');
		const metalang = rec.language && META_LANG[rec.language] ? META_LANG[rec.language] : null;
		const slug = uniqueSlug(
			`${rec.year ?? 'nd'}-${slugify(rec.authors[0] ?? '') || 'x'}-${slugify(rec.title).slice(0, 50) || djb2(rec.externalId)}`
		);
		const cls = classifyAcademic(rec);
		sourceRows.push({
			id,
			slug,
			title: rec.title,
			// Only mirror the title into title_en when it is genuinely Latin-script;
			// a Cyrillic/Hangul/CJK title is not its own English translation.
			titleEn: isLatinTitle(rec.title) ? rec.title : null,
			category: cls.category,
			type: cls.type,
			author: rec.authors.join(', ') || null,
			...y,
			languages: metalang ? ['ain', metalang] : ['ain'],
			scripts: detectScripts(rec.title),
			summary: rec.venue ?? null,
			provenanceRepo: rec.source,
			provenancePath: rec.externalId,
			externalIds: { ...(doi ? { doi } : {}), [rec.source]: rec.externalId },
			createdAt: new Date(),
			updatedAt: new Date()
		});
		idByTitle.set(nt, id);
		idByCore.set(coreKey(rec.title), id);
		if (doi) idByDoi.set(doi, id);
		let so = 0;
		if (rec.url) addLink(id, doi ? 'doi' : 'website', rec.url, doi ? `doi:${rec.doi}` : rec.venue, so++);
		if (rec.pdf) addLink(id, 'pdf', rec.pdf, 'Open access PDF', so++);
		for (const l of rec.links ?? []) addLink(id, l.type, l.url, l.label, so++);
		if (rec.source === 'openalex') oaToSource.set(rec.externalId, id);
		addPersonsGated(id, rec.authors ?? [], prominentAuthors);
		// Geo-locate the work from the dialect/region named in its title (沙流方言,
		// Sakhalin Ainu, 千歳…). For a study this is its SUBJECT area (対象地域), not a
		// recording dialect. Only real gazetteer place-names match; titles with an
		// institutional "北海道大学" context are stripped first to avoid a false pin.
		addPlaces(id, geoSubjectText(rec.title), 'subject');
		attachTags(id, rec.title, cls.type, rec.venue); // title + NORMALIZED type (dictionary→lexicon…) + venue (言語処理学会/LREC→nlp); raw rec.type still holds legacy 'grammar-article'
		attachVenueTags(id, rec.venue); // guarded journal/series signal (地名研究→placenames…)
		added += 1;
	}
	if (enriched) console.log(`  academic: enriched ${enriched} existing source(s) with IIIF/transcription links`);
	console.log(`  academic: ${prominentAuthors.size} authors promoted to person entities (≥${AUTHOR_MIN_WORKS} works)`);

	// Materialise the OpenAlex citation graph as source_relations(type='cites').
	// Each edge A→B is a real OpenAlex-attested citation between two works we hold;
	// we drop edges whose endpoints merged into the same source (self-loops) and
	// de-duplicate so a (from,to) pair is recorded once.
	let cites = 0;
	if (fs.existsSync(CITATION_EDGES_FILE)) {
		const edges: { from: string; to: string }[] = JSON.parse(fs.readFileSync(CITATION_EDGES_FILE, 'utf8'));
		const yearById = new Map(sourceRows.map((s) => [s.id as string, s.yearStart as number | null]));
		const seen = new Set<string>();
		let dropped = 0;
		for (const e of edges) {
			const fromId = oaToSource.get(e.from);
			const toId = oaToSource.get(e.to);
			if (!fromId || !toId || fromId === toId) continue;
			// Drop chronologically impossible citations: a work cannot cite one
			// published more than a year later. After SOURCE_YEAR_OVERRIDES fixes the
			// reprint-dated targets, the survivors are genuine reversed edges.
			const fy = yearById.get(fromId);
			const ty = yearById.get(toId);
			if (fy != null && ty != null && fy < ty - 1) { dropped++; continue; }
			const k = `${fromId}\t${toId}`;
			if (seen.has(k)) continue;
			seen.add(k);
			sourceRelationRows.push({ id: uuid(), fromSourceId: fromId, toSourceId: toId, type: 'cites', notes: null });
		}
		cites = sourceRelationRows.length;
		console.log(`  academic: ${cites} citation relations (cites) from ${edges.length} edges (dropped ${dropped} chronologically impossible)`);
	}
	return { added, skipped, cites };
}

// ---------------------------------------------------------------------------
// Wikidata / Wikipedia enrichment for persons
//
// For each person we query the Wikidata API by name, accept ONLY a human (P31
// = Q5) whose label/alias matches the name, and keep its QID + an actually
// existing Wikipedia article URL. Results are cached to disk so re-seeds don't
// re-hit the API. Anything uncertain is left null → no link is shown (we never
// fabricate a link or guess an article that may not exist).
// ---------------------------------------------------------------------------
const WIKIDATA_CACHE_FILE = path.join(import.meta.dir, 'wikidata-cache.json');
const WIKIDATA_DATES_CACHE_FILE = path.join(import.meta.dir, 'wikidata-dates-cache.json');
const WD_UA = 'ainu-sources-seed/1.0 (https://db.aynu.org; mkpoli@mkpo.li)';

type WdHit = { wikidata: string | null; wikipedia: string | null; enLabel: string | null };

const ORG_RE =
	/consortium|project|contributors|wiktionary|et al|various|compiler|\bNINJAL\b|kyokai|kyōkai|foundation|museum|university|institute|\bAA研\b|loanwordbank|associat/i;

// The matched Wikidata entity's description must point to this domain, or we
// reject it — guards against same-name collisions (athletes, pop singers, …)
// that name-matching alone lets through.
const RELEVANCE_RE =
	/ainu|アイヌ|linguist|言語学|philolog|anthropolog|人類学|民族学|ethnolog|ethnograph|missionary|宣教|explorer|navigator|探検|naturalist|博物|orientalist|東洋学|japanolog|lexicograph|辞書|folklor|民俗|言語|方言|поэт|лингвист|этнограф|мореплавател|путешественник|священник|миссионер/i;

function normName(s: string): string {
	return stripParens(s)
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]/gu, '')
		.replace(/\s+/g, '') // strip all spaces so "奥田 統己" matches label "奥田統己"
		.trim();
}

const wdSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON from the Wikidata API. Retries on rate-limit (429) / 5xx with
 * backoff. Returns parsed JSON on success, null on a genuine non-retryable 4xx,
 * and THROWS after exhausting retries (so callers can avoid caching a transient
 * failure as a permanent "no match").
 */
async function wdFetch(url: string): Promise<any | null> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetch(url, { headers: { 'User-Agent': WD_UA, Accept: 'application/json' } });
			if (res.status === 429 || res.status >= 500) {
				await wdSleep(500 * (attempt + 1));
				continue;
			}
			if (!res.ok) return null;
			return await res.json();
		} catch {
			await wdSleep(500 * (attempt + 1));
		}
	}
	throw new Error(`wdFetch failed after retries: ${url}`);
}

async function lookupWikidata(name: string, native: string): Promise<WdHit | null> {
	const empty: WdHit = { wikidata: null, wikipedia: null, enLabel: null };
	// Try the display name, the native name, and a space-stripped native variant
	// (Japanese names match better without the surname/given space on Wikidata).
	const queries = [name, native, native.replace(/\s+/g, '')].filter(
		(q, i, a) => q && a.indexOf(q) === i
	);
	const candidateIds: string[] = [];
	try {
		for (const q of queries) {
			const searchLang = hasCJK(q) ? 'ja' : 'en';
			const data = await wdFetch(
				`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=5&language=${searchLang}&uselang=${searchLang}&search=${encodeURIComponent(q)}`
			);
			for (const c of data?.search ?? []) if (!candidateIds.includes(c.id)) candidateIds.push(c.id);
			if (candidateIds.length >= 7) break;
		}
		if (!candidateIds.length) return empty;

		var ent = await wdFetch(
			`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks/urls|labels|aliases|descriptions&ids=${candidateIds.slice(0, 7).join('|')}`
		);
	} catch {
		return null; // transient API failure — let the caller retry next run
	}
	if (!ent?.entities) return empty;

	const wantCjk = hasCJK(native);
	// A full kanji name is highly unambiguous, so a *unique* such match is safe to
	// accept even when Wikidata has no description (many Ainu speakers/tradition-
	// bearers lack one). Common Latin/katakana names still require the relevance
	// gate, which keeps out same-name athletes/singers/actors.
	const kanjiName = /[㐀-鿿々]/.test(native) && native.replace(/\s+/g, '').length >= 3;
	const targets = [normName(name), normName(native)].filter(Boolean);

	// Collect human candidates whose label/alias actually matches the name.
	const matches: { e: any; id: string; relevant: boolean }[] = [];
	for (const id of candidateIds) {
		const e = ent.entities[id];
		if (!e || e.missing !== undefined) continue;
		const isHuman = (e.claims?.P31 ?? []).some(
			(c: any) => c?.mainsnak?.datavalue?.value?.id === 'Q5'
		);
		if (!isHuman) continue;
		const forms = new Set<string>();
		for (const lbl of Object.values(e.labels ?? {})) forms.add(normName((lbl as any).value));
		for (const arr of Object.values(e.aliases ?? {}))
			for (const a of arr as any[]) forms.add(normName(a.value));
		if (!targets.some((t) => t && forms.has(t))) continue;
		const descText = Object.values(e.descriptions ?? {})
			.map((d: any) => d.value)
			.join(' • ');
		matches.push({ e, id, relevant: RELEVANCE_RE.test(descText) });
	}
	if (!matches.length) return empty;

	// Prefer a relevance-confirmed match; otherwise accept a unique kanji-name hit.
	const chosen =
		matches.find((m) => m.relevant) ?? (kanjiName && matches.length === 1 ? matches[0] : null);
	if (!chosen) return empty;

	const sl = chosen.e.sitelinks ?? {};
	const order = wantCjk ? ['jawiki', 'enwiki', 'ruwiki'] : ['enwiki', 'jawiki', 'ruwiki'];
	let wikipedia: string | null = null;
	for (const wiki of order) {
		if (sl[wiki]?.url) {
			wikipedia = sl[wiki].url;
			break;
		}
	}
	const enLabel = chosen.e.labels?.en?.value ?? null;
	return { wikidata: chosen.id, wikipedia, enLabel: enLabel && !hasCJK(enLabel) ? enLabel : null };
}

async function enrichPersonsWithWikidata() {
	let cache: Record<string, WdHit> = {};
	if (fs.existsSync(WIKIDATA_CACHE_FILE)) {
		try {
			cache = JSON.parse(fs.readFileSync(WIKIDATA_CACHE_FILE, 'utf8'));
		} catch {
			cache = {};
		}
	}
	// Space/parenthesis-insensitive key so name normalization (e.g. adding the
	// surname/given space) doesn't invalidate cached lookups.
	const ck = (p: Row) => stripParens(p.name as string).replace(/\s+/g, '');
	const todo = personRows.filter((p) => !(ck(p) in cache));
	if (todo.length) {
		console.log(`Enriching ${todo.length} persons via Wikidata (cached: ${personRows.length - todo.length})…`);
	}
	const CONC = 3; // keep low to avoid Wikidata rate-limiting
	for (let i = 0; i < todo.length; i += CONC) {
		if (i > 0) await wdSleep(150);
		const batch = todo.slice(i, i + CONC);
		await Promise.all(
			batch.map(async (p) => {
				const display = (p.nameEn as string) || (p.name as string);
				if (ORG_RE.test(display)) {
					cache[ck(p)] = { wikidata: null, wikipedia: null, enLabel: null };
					return;
				}
				const hit = await lookupWikidata(display, p.name as string);
				if (hit) cache[ck(p)] = hit; // skip caching transient failures (null)
			})
		);
	}
	fs.writeFileSync(WIKIDATA_CACHE_FILE, JSON.stringify(cache, null, 2));
	let withWp = 0;
	let romajiFilled = 0;
	for (const p of personRows) {
		const hit = cache[ck(p)];
		if (!hit) continue;
		// Don't override hand-verified curated values (PERSON_ENRICH / PERSON_CANON).
		if (!p.wikidata) p.wikidata = hit.wikidata;
		if (!p.wikipedia) p.wikipedia = hit.wikipedia;
		if (hit.wikipedia) withWp += 1;
		// Backfill romaji for CJK-named people from the verified Wikidata label.
		if ((!p.nameEn || p.nameEn === p.name) && hit.enLabel && hasCJK(p.name as string)) {
			p.nameEn = hit.enLabel;
			romajiFilled += 1;
		}
	}
	console.log(
		`Wikidata: ${withWp} verified Wikipedia articles, ${romajiFilled} romaji names backfilled.`
	);
}

// Parse a 4-digit year from a Wikidata time claim ("+1909-05-24T00:00:00Z").
function wdYearFromClaim(claims: any, prop: string): number | null {
	const val = claims?.[prop]?.[0]?.mainsnak?.datavalue?.value;
	const t = val?.time;
	if (!t) return null;
	// Wikidata precision: 9=year, 8=decade, 7=century, 6=millennium. Anything
	// coarser than a year is not a real year — e.g. 寺島良安's death is century
	// precision (+1800 = "18th c."), which must NOT be stored as the literal 1800.
	if (typeof val.precision === 'number' && val.precision < 9) return null;
	const m = String(t).match(/^([+-])(\d{1,4})/);
	if (!m) return null;
	const y = Number(m[2]) * (m[1] === '-' ? -1 : 1);
	return Number.isFinite(y) && y !== 0 ? y : null;
}

// Birth/death years + Wikipedia article for every person that has a Wikidata QID
// — a cheap batch pass over wbgetentities (P569/P570 + sitelinks), so historical
// figures show life dates (田村すゞ子 1934–2015, 知里真志保 1909–1961…) and a
// direct article link even when the QID came from PERSON_ENRICH (bypassing the
// name search). QID-keyed cache; entries missing `wp` are re-fetched.
async function enrichPersonDates() {
	const qids = [...new Set(personRows.map((p) => p.wikidata as string).filter(Boolean))];
	if (!qids.length) return;
	let cache: Record<string, { b: number | null; d: number | null; wp?: string | null }> = {};
	if (fs.existsSync(WIKIDATA_DATES_CACHE_FILE)) {
		try {
			cache = JSON.parse(fs.readFileSync(WIKIDATA_DATES_CACHE_FILE, 'utf8'));
		} catch {
			cache = {};
		}
	}
	const todo = qids.filter((q) => !(q in cache) || cache[q].wp === undefined);
	if (todo.length) console.log(`Fetching dates + Wikipedia for ${todo.length} Wikidata persons (cached: ${qids.length - todo.length})…`);
	for (let i = 0; i < todo.length; i += 45) {
		const batch = todo.slice(i, i + 45);
		let data: any = null;
		try {
			data = await wdFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks/urls&ids=${batch.join('|')}`);
		} catch {
			continue;
		}
		for (const qid of batch) {
			const e = data?.entities?.[qid];
			const sl = e?.sitelinks ?? {};
			const wp = sl.jawiki?.url ?? sl.enwiki?.url ?? sl.ruwiki?.url ?? null;
			cache[qid] = { b: wdYearFromClaim(e?.claims, 'P569'), d: wdYearFromClaim(e?.claims, 'P570'), wp };
		}
		await wdSleep(150);
	}
	fs.writeFileSync(WIKIDATA_DATES_CACHE_FILE, JSON.stringify(cache, null, 2));
	let filled = 0;
	for (const p of personRows) {
		const c = p.wikidata ? cache[p.wikidata as string] : null;
		if (!c) continue;
		if (p.birthYear == null && c.b != null) { p.birthYear = c.b; filled += 1; }
		if (p.deathYear == null && c.d != null) p.deathYear = c.d;
		if (!p.wikipedia && c.wp) p.wikipedia = c.wp;
	}
	// Verified person-identity corrections, applied LAST so they win over the cache.
	let corrected = 0;
	for (const p of personRows) {
		const ov = PERSON_OVERRIDES[p.name as string];
		if (!ov) continue;
		for (const [k, v] of Object.entries(ov)) (p as Row)[k] = v;
		corrected += 1;
	}
	console.log(`Wikidata dates: life years set for ${filled} persons; ${corrected} identity corrections.`);
}

// Verified corrections for persons carrying wrong Wikidata-derived identity/dates.
// Keyed by `name`; explicit null clears a field. (Terashima's death is genuinely
// unknown — 没年不詳; 井上文夫 was merged with an unrelated comedian QID Q11366642.)
const PERSON_OVERRIDES: Record<string, Record<string, unknown>> = {
	'寺島 良安': { deathYear: null },
	'井上 文夫': { birthYear: null, deathYear: null, wikidata: null, wikipedia: null, nameEn: 'Inoue Fumio' }
};

// ---------------------------------------------------------------------------
// Bulk insert helper (chunked)
// ---------------------------------------------------------------------------
async function bulkInsert(table: Parameters<typeof db.insert>[0], rows: Row[]) {
	const CHUNK = 200;
	for (let i = 0; i < rows.length; i += CHUNK) {
		await db.insert(table).values(rows.slice(i, i + CHUNK) as never);
	}
}

// ---------------------------------------------------------------------------
// Revision safety — NEVER lose user edits/history on reseed.
//
// A user-created or -edited source carries source_revisions (create/update).
// We capture those + the edited source rows BEFORE wiping, back them up to a
// timestamped JSON file, then AFTER the fresh seed we re-apply each user edit
// on top of the regenerated source and re-insert every revision (re-pointed to
// the live source). Set FORCE_FRESH=1 to intentionally start clean (still
// backs up first). Matching uses the stable identity (provenanceRepo+path).
// ---------------------------------------------------------------------------
interface Preserved {
	revisions: Record<string, unknown>[];
	editedSources: Record<string, unknown>[];
}

const srcIdentity = (r: Record<string, unknown>) =>
	`${r.provenanceRepo ?? ''} ${r.provenancePath ?? ''}`;

// Columns a user can change — overlaid back onto the regenerated source.
const CONTENT_COLS = [
	'title', 'titleEn', 'titleAin', 'altTitles', 'category', 'type', 'author',
	'yearText', 'yearStart', 'yearEnd', 'yearCertainty', 'dialect', 'region',
	'languages', 'scripts', 'holdingInstitution', 'callNumber', 'entryCount',
	'entryCountLabel', 'license', 'summary', 'notes', 'reliability', 'externalIds',
	'featured', 'updatedAt'
];

async function captureUserContent(): Promise<Preserved> {
	let revisions: Record<string, unknown>[] = [];
	try {
		revisions = (await db.select().from(schema.sourceRevisions)) as Record<string, unknown>[];
	} catch {
		return { revisions: [], editedSources: [] }; // table missing on first ever seed
	}
	if (!revisions.length) return { revisions: [], editedSources: [] };
	const ids = [...new Set(revisions.map((r) => r.sourceId).filter(Boolean))] as string[];
	const editedSources = ids.length
		? ((await db.select().from(schema.sources).where(inArray(schema.sources.id, ids))) as Record<string, unknown>[])
		: [];
	const dir = path.join(import.meta.dir, 'data', 'backups');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `user-content-${Date.now()}.json`);
	fs.writeFileSync(file, JSON.stringify({ revisions, editedSources }, null, 2));
	console.log(`🛟 Backed up ${revisions.length} revision(s) + ${editedSources.length} edited source(s) → ${path.relative(process.cwd(), file)}`);
	return { revisions, editedSources };
}

async function restoreUserContent(p: Preserved) {
	if (!p.revisions.length) return;
	if (process.env.FORCE_FRESH) {
		console.warn(`⚠️  FORCE_FRESH set — NOT restoring ${p.revisions.length} revision(s) (backup kept).`);
		return;
	}
	const freshByIdentity = new Map(sourceRows.map((s) => [srcIdentity(s), s]));
	const remap = new Map<string, string>(); // old source id → live source id
	const reinsert: Row[] = [];
	let overlaid = 0;
	for (const es of p.editedSources) {
		const fresh = freshByIdentity.get(srcIdentity(es)) as Record<string, unknown> | undefined;
		if (fresh) {
			remap.set(es.id as string, fresh.id as string);
			const vals: Row = {};
			for (const c of CONTENT_COLS) if (c in es) vals[c] = es[c];
			await db.update(schema.sources).set(vals as never).where(eq(schema.sources.id, fresh.id as string));
			overlaid += 1;
		} else {
			// User-created source the seed doesn't regenerate — keep it as-is.
			remap.set(es.id as string, es.id as string);
			reinsert.push(es as Row);
		}
	}
	if (reinsert.length) await bulkInsert(schema.sources, reinsert);
	const revs = p.revisions.map((r) => ({
		...r,
		sourceId: r.sourceId ? remap.get(r.sourceId as string) ?? r.sourceId : r.sourceId
	}));
	await bulkInsert(schema.sourceRevisions, revs as Row[]);
	console.log(`♻️  Restored ${p.revisions.length} revision(s); re-applied ${overlaid} user edit(s); re-inserted ${reinsert.length} user-created source(s).`);
}

async function wipe() {
	// order matters: children before parents (FK)
	await db.delete(schema.sourceRevisions);
	await db.delete(schema.sourceRelations);
	await db.delete(schema.sourceTags);
	await db.delete(schema.sourcePersons);
	await db.delete(schema.sourcePlaces);
	await db.delete(schema.sourceInstitutions);
	await db.delete(schema.sourceLinks);
	await db.delete(schema.sources);
	await db.delete(schema.tags);
	await db.delete(schema.persons);
	await db.delete(schema.places);
	await db.delete(schema.institutions);
}

// ---------------------------------------------------------------------------
// Curated bibliographies (hand-entered reading lists, e.g. the 帯広百年記念館
// リウカ / 幕別町図書館 十勝-Ainu list). Each entry is real bibliographic data.
// Dedup by normalized title against everything seeded so far: a match is
// ENRICHED (holding library, curated summary, web link) rather than duplicated;
// a miss is inserted as a new source.
// ---------------------------------------------------------------------------
const CURATED_BIBLIO_FILE = path.join(import.meta.dir, 'data', 'curated-biblio.json');
interface CuratedEntry {
	num: string; title: string; titleEn?: string | null; authors: string[];
	publisher?: string; year?: number | null; type: string; category: string;
	langs: string[]; scripts?: string[]; url?: string; urlType?: string;
	summary?: string; holding?: string; callNumber?: string; dialect?: string;
}
function seedCuratedBiblio(): { added: number; enriched: number } {
	if (!fs.existsSync(CURATED_BIBLIO_FILE)) return { added: 0, enriched: 0 };
	const entries: CuratedEntry[] = JSON.parse(fs.readFileSync(CURATED_BIBLIO_FILE, 'utf8'));
	const idByTitle = new Map<string, Row>();
	for (const s of sourceRows) {
		const t = normTitle(s.title as string);
		if (t && !idByTitle.has(t)) idByTitle.set(t, s);
		if (s.titleEn) { const te = normTitle(s.titleEn as string); if (te && !idByTitle.has(te)) idByTitle.set(te, s); }
	}
	const linkKey = new Set(linkRows.map((l) => `${l.sourceId}\t${l.url}`));
	let added = 0, enriched = 0;
	for (const e of entries) {
		const nt = normTitle(e.title);
		const hit = nt ? idByTitle.get(nt) : undefined;
		if (hit) {
			// Enrich an existing record (e.g. a famous book already pulled via NDL/CiNii).
			if (!hit.holdingInstitution && e.holding) hit.holdingInstitution = e.holding;
			if (!hit.callNumber && e.callNumber) hit.callNumber = e.callNumber;
			if ((!hit.summary || hit.summary === '') && e.summary) hit.summary = e.summary;
			if (e.url && !linkKey.has(`${hit.id}\t${e.url}`)) {
				linkRows.push({ id: uuid(), sourceId: hit.id, type: e.urlType ?? 'website', label: e.publisher ?? null, url: e.url, sortOrder: 90 });
				linkKey.add(`${hit.id}\t${e.url}`);
			}
			enriched += 1;
			continue;
		}
		const id = uuid();
		const slug = uniqueSlug(`${e.year ?? 'nd'}-${slugify(e.titleEn ?? '') || slugify(e.authors[0] ?? '') || 'x'}-${slugify(e.title).slice(0, 40) || `biblio-${e.num}`}`);
		sourceRows.push({
			id, slug, title: e.title, titleEn: e.titleEn ?? null,
			category: e.category, type: e.type, author: e.authors.join('、') || null,
			yearText: e.year ? String(e.year) : '', yearStart: e.year ?? null, yearEnd: null,
			yearCertainty: e.year ? 'exact' : 'unknown', dialect: e.dialect ?? null, region: null,
			languages: e.langs, scripts: e.scripts ?? ['kana', 'kanji'],
			holdingInstitution: e.holding ?? null, callNumber: e.callNumber ?? null,
			summary: e.summary ?? null, provenanceRepo: 'curated-makubetsu', provenancePath: `biblio/${e.num}`,
			createdAt: new Date(), updatedAt: new Date()
		});
		idByTitle.set(nt, sourceRows[sourceRows.length - 1]);
		if (e.url) linkRows.push({ id: uuid(), sourceId: id, type: e.urlType ?? 'website', label: e.publisher ?? null, url: e.url, sortOrder: 0 });
		if (e.authors.length) addPersons(id, e.authors.join('、'), 'author');
		addPlaces(id, `${geoSubjectText(e.title)} ${e.dialect ?? ''}`, 'subject');
		attachTags(id, e.title, e.titleEn, e.summary);
		added += 1;
	}
	console.log(`  curated biblio: +${added} new, ${enriched} enriched`);
	return { added, enriched };
}

// A title carries a part/continuation marker (多巻 serial installment) — used to
// tell genuine same-work serials apart from editions/duplicates of one title.
const PART_MARKER_RE = /[(（]\s*[0-9０-９]+\s*[)）]|その\s*[0-9０-９一二三四五六七八九十]+|第\s*[0-9０-９一二三四五六七八九十]+\s*[回報編]|\bpart\s*[0-9]+|[(（]\s*[上中下一二三四五六七八九十]\s*[)）]|續|続|績|承前|つづき|補遺|遺稿|續稿|続稿|後篇|前篇|前編|後編|上巻|下巻|乾|坤/;
const hasPartMarker = (t: string) => PART_MARKER_RE.test(t);
// Loose author agreement (romanization/delimiter/variant-tolerant) — only used to
// flag the safest duplicates, never as a gate (it false-negatives on romaji variants).
function authAgree(a: string, b: string): boolean {
	const norm = (s: string) => (s || '').normalize('NFKC').replace(/[\s　,;，；・]+/g, '').toLowerCase();
	const x = norm(a), y = norm(b);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

// Link the scattered parts of one work, clustered by coreKey (volume/part/holding-
// suffix-stripped title). Classifies each pair: genuine multi-part serials (藻汐草
// 乾/坤, アイヌ語会話篇 一–五, Dobrotvorsky 19 installments) stay `same-work`; a title
// that contains another with the SAME year but from a different repo is `duplicate-of`;
// the same title at a DIFFERENT year is `edition-of` (oldest = the original work).
// The part-marker guard is mandatory — without it the substring rule matches every
// installment against the bare base title and inflates editions 14→53 false pairs.
function buildSameWorkRelations(): number {
	const byCore = new Map<string, Row[]>();
	for (const s of sourceRows) {
		const k = coreKey(s.title as string);
		if (k.length < 5) continue;
		if (!byCore.has(k)) byCore.set(k, []);
		byCore.get(k)!.push(s);
	}
	let same = 0, editions = 0, dups = 0;
	for (const cluster of byCore.values()) {
		if (cluster.length < 2) continue;
		if (new Set(cluster.map((s) => s.title)).size < 2) continue; // identical titles ⇒ not a part series
		if (cluster.length > 30) continue; // pathological (a too-generic core title) — skip
		for (let i = 0; i < cluster.length; i++)
			for (let j = i + 1; j < cluster.length; j++) {
				const a = cluster[i], b = cluster[j];
				const ta = String(a.title), tb = String(b.title);
				const na = normTitle(ta), nb = normTitle(tb);
				const substr = na.includes(nb) || nb.includes(na);
				const ya = a.yearStart as number | null, yb = b.yearStart as number | null;
				if (!hasPartMarker(ta) && !hasPartMarker(tb) && substr && ya != null && yb != null && ya !== yb) {
					const [from, to] = ya > yb ? [a, b] : [b, a]; // newer cites older; oldest = original
					sourceRelationRows.push({ id: uuid(), fromSourceId: from.id, toSourceId: to.id, type: 'edition-of', notes: null });
					editions++;
				} else if (!hasPartMarker(ta) && !hasPartMarker(tb) && substr && ya != null && yb != null && ya === yb) {
					const note = authAgree(String(a.author ?? ''), String(b.author ?? '')) ? 'author-confirmed' : null;
					sourceRelationRows.push({ id: uuid(), fromSourceId: a.id, toSourceId: b.id, type: 'duplicate-of', notes: note });
					dups++;
				} else {
					sourceRelationRows.push({ id: uuid(), fromSourceId: a.id, toSourceId: b.id, type: 'same-work', notes: null });
					same++;
				}
			}
	}
	console.log(`  coreKey relations: same-work ${same}, edition-of ${editions}, duplicate-of ${dups}`);
	return same + editions + dups;
}

const dedupeBy = (rows: Row[], cols: string[]) => {
	const seen = new Set<string>();
	return rows.filter((r) => {
		const k = cols.map((c) => r[c]).join('\t');
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
};

// The 1893 北海氣象 source documents Kuril-Ainu speech RECORDED on 色丹島 — a recording
// location, not merely a subject region. Promote that link to 'record' on the desired
// rows (was once a manual post-reseed SQL step). Applies to both plan and apply.
function applyShikotanRecordRole() {
	const src = sourceRows.find((s) => /北海氣象/.test((s.title as string) ?? ''));
	const place = placeRows.find((p) => p.name === '色丹島');
	if (src && place)
		for (const r of sourcePlaceRows)
			if (r.sourceId === src.id && r.placeId === place.id) r.role = 'record';
}

// --- PLAN mode -------------------------------------------------------------
// Diff the freshly-built desired rows against the LIVE DB and print what an apply
// WOULD change — WITHOUT writing anything. A guardrail against a broken parser
// silently wiping prod: a bad run shows up here as a huge red diff you can reject.
// (Excludes Wikidata field-enrichment and the user-content restore, which don't
// change row counts.) Run: `bun run seed:plan` against prod.
async function planDiff(desired: Record<string, Row[]>) {
	console.log('\n=== PLAN — no changes written (counts only; enrichment fields not diffed) ===');
	const order = [
		'sources', 'persons', 'places', 'institutions', 'tags', 'source_links',
		'source_persons', 'source_institutions', 'source_places', 'source_tags', 'source_relations'
	];
	let danger = false;
	const tableRows: Record<string, unknown>[] = [];
	for (const name of order) {
		const cur = Number((await client.execute(`SELECT COUNT(*) AS n FROM ${name}`)).rows[0].n);
		const des = desired[name].length;
		const delta = des - cur;
		const drop = cur > 50 && des < cur * 0.5;
		if (drop) danger = true;
		tableRows.push({
			table: name, live: cur, desired: des,
			delta: (delta >= 0 ? '+' : '') + delta,
			flag: drop ? '⚠️ LARGE DROP' : des === 0 && cur > 0 ? '⚠️ EMPTIED' : ''
		});
		if (des === 0 && cur > 0) danger = true;
	}
	console.table(tableRows);

	// Identity-level diff for sources (provenance is the stable key; slug fallback).
	const idOf = (repo: unknown, p: unknown, slug: unknown) =>
		repo && p ? `${repo} ${p}` : `slug:${slug}`;
	const live = (await client.execute(`SELECT provenance_repo, provenance_path, slug FROM sources`)).rows;
	const liveSet = new Set(live.map((r) => idOf(r.provenance_repo, r.provenance_path, r.slug)));
	const desSet = new Set(desired.sources.map((r) => idOf(r.provenanceRepo, r.provenancePath, r.slug)));
	const added = [...desSet].filter((k) => !liveSet.has(k));
	const removed = [...liveSet].filter((k) => !desSet.has(k));
	console.log(`\nsources by identity:  +${added.length} new   -${removed.length} removed   ${desSet.size - added.length} kept (updated in place)`);
	if (removed.length) {
		console.log(`  sample of the ${removed.length} that would DISAPPEAR on apply:`);
		for (const k of removed.slice(0, 15)) console.log('   -', String(k).replace(' ', '  /  '));
	}
	console.log(
		danger
			? '\n⚠️  REVIEW BEFORE APPLYING — a table would lose >50% of its rows or be emptied. Likely a broken parser/source file. Do NOT apply unless this is intended.'
			: '\n✓ No catastrophic drops. Re-run without --plan to apply (full wipe+rebuild).'
	);
}

async function main() {
	const PLAN = process.argv.includes('--plan') || process.env.PLAN === '1';
	console.log('AINU_ROOT =', AINU_ROOT, PLAN ? '(PLAN MODE — read-only)' : '');
	// Phase-0 safety gate: the non-PLAN path is a destructive full wipe + rebuild
	// (wipe() db.delete's every domain table). Refuse to run it unless explicitly
	// authorized, so `bun run seed` can never silently destroy prod. PLAN/--plan is
	// read-only and intentionally NOT gated.
	if (!PLAN && process.env.ALLOW_LEGACY_WIPE !== '1') {
		throw new Error(
			'Refusing destructive seed: this wipes every domain table then rebuilds and can ' +
				'destroy production data. Use `bun run seed:plan` (or --plan / PLAN=1) for a ' +
				'read-only diff, or set ALLOW_LEGACY_WIPE=1 to explicitly authorize the wipe.'
		);
	}
	const preserved = PLAN ? null : (console.log('Capturing user content (revisions + edits) before wipe…'), await captureUserContent());
	if (!PLAN) {
		console.log('Wiping domain tables…');
		await wipe();
	}

	const nDict = seedDictionaries();
	const nGram = seedGrammar();
	const nCorp = await seedCorpus();
	const nManual = seedManual();
	const acad = seedAcademic();
	const curated = seedCuratedBiblio();
	buildSameWorkRelations();

	if (!PLAN) {
		await enrichPersonsWithWikidata();
		await enrichPersonDates();
	}

	// Normalise `scripts` for EVERY source from the actual glyphs in its titles —
	// several seed paths (catalog dict, hard-coded grammar blocks) set scripts from
	// a language guess and mis-tag Japanese titles as ['latn']. Title text is ground
	// truth for "which writing systems this work's titles use".
	for (const s of sourceRows) s.scripts = detectScripts(s.title as string, s.titleEn as string);
	applyShikotanRecordRole();

	// Dedupe the join tables exactly as the insert path does, so plan counts match.
	const sourcePersonDedup = dedupeBy(sourcePersonRows, ['sourceId', 'personId', 'role']);
	const sourcePlaceDedup = dedupeBy(sourcePlaceRows, ['sourceId', 'placeId', 'role']);
	const sourceTagDedup = dedupeBy(sourceTagRows, ['sourceId', 'tagId']);
	const sourceRelationDedup = dedupeBy(sourceRelationRows, ['fromSourceId', 'toSourceId', 'type']);

	if (PLAN) {
		await planDiff({
			sources: sourceRows, persons: personRows, places: placeRows, institutions: instRows,
			tags: tagRows, source_links: linkRows, source_persons: sourcePersonDedup,
			source_institutions: sourceInstRows, source_places: sourcePlaceDedup,
			source_tags: sourceTagDedup, source_relations: sourceRelationDedup
		});
		process.exit(0);
	}

	console.log('Inserting…');
	await bulkInsert(schema.persons, personRows);
	await bulkInsert(schema.places, placeRows);
	await bulkInsert(schema.institutions, instRows);
	await bulkInsert(schema.tags, tagRows);
	await bulkInsert(schema.sources, sourceRows);
	await bulkInsert(schema.sourceLinks, linkRows);
	console.log(`  source_persons: ${sourcePersonRows.length} → ${sourcePersonDedup.length} (deduped ${sourcePersonRows.length - sourcePersonDedup.length})`);
	await bulkInsert(schema.sourcePersons, sourcePersonDedup);
	await bulkInsert(schema.sourcePlaces, sourcePlaceDedup);
	await bulkInsert(schema.sourceInstitutions, sourceInstRows);
	await bulkInsert(schema.sourceTags, sourceTagDedup);
	await bulkInsert(schema.sourceRelations, sourceRelationDedup);

	await restoreUserContent(preserved);

	console.log('--- seeded ---');
	console.table({
		dictionaries: nDict,
		grammar: nGram,
		corpus: nCorp,
		manual: nManual,
		academic: acad.added,
		'academic dup': acad.skipped,
		'curated +/enrich': `${curated.added}/${curated.enriched}`,
		sources: sourceRows.length,
		persons: personRows.length,
		places: placeRows.length,
		institutions: instRows.length,
		tags: tagRows.length,
		links: linkRows.length,
		relations: sourceRelationRows.length
	});
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
