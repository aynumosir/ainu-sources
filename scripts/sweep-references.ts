#!/usr/bin/env bun
/**
 * Scan every locally available OCR text for a terminal bibliography, resolve
 * title mentions against the ainu-sources catalogue, and write reviewable
 * extracted-cites/v1 datasets under scripts/data/extracted-cites/generated/.
 *
 * The sweep is deliberately conservative:
 *   • it searches only text after a bibliography/reference heading;
 *   • a catalogue title/alternate title must occur as a normalized substring;
 *   • a title that only ever occurs inside a longer matched title is dropped, so
 *     the longer reference keeps the edge its own text earned;
 *   • year or author corroboration makes a match `probable`;
 *   • title-only matches remain `candidate`;
 *   • no new source record is proposed from OCR.
 *
 * The generated files are consumed by scripts/import/extracted-cites.ts.
 * Probable matches become accepted citation edges. Candidate matches are stored
 * as candidate edges, outside the public network and PageRank calculation.
 *
 * Ordering: where two catalogue records hold the same work, the sweep picks between
 * them partly on `sources.significance` — the PageRank over the edges this sweep
 * itself feeds. Output therefore depends on when that score was last refreshed, so
 * run `archive:refresh-significance` BEFORE a sweep whose result you intend to
 * compare against an earlier one. Measured, the dependency moves 2 edges in 1,598
 * across a refresh; ranking on record properties instead was tried and picks worse
 * records, so the score stays and the ordering is documented rather than removed.
 *
 * Run:
 *   DATABASE_URL=file:./local.db bun run sweep:references
 *
 * Optional paths:
 *   --ocr-root <repo>       default: $AINU_ROOT/ainu-grammar or ../ainu-grammar
 *   --manifest <jsonl>      default: ../ainu-archive/.archive/manifest-ainu-grammar.jsonl
 *   --output <dir>          default: scripts/data/extracted-cites/generated
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { openDb } from './import/lib/entities';
import { sources } from '../src/lib/server/db/schema';
import { ACTIVE_SOURCE_STATUS } from '../src/lib/server/visibility';

const GENERATED_SCHEMA = 'extracted-cites/v1';
/** What ends a reference section. Indexes and appendices list names and years too. */
const TERMINAL_CORE =
	/(?:appendix|appendices|index(?:\s+of\s+(?:authors|names|subjects))?|author\s+index|name\s+index|subject\s+index|about\s+the\s+author|author\s+biograph(?:y|ies)|acknowledge?ments?|付録|附録|索引|人名索引|事項索引|語彙索引|著者紹介|著者略歴|あとがき|後記|初出一覧|謝辞)/iu;
// A part label — Appendix A, 索引 2 — never a run of letters, so "Indexing the
// corpus" cannot be read as a closing heading.
const TERMINAL_TAIL = /(?:[a-z](?![a-z])|[0-9０-９]+|一覧|表)/iu;

// A heading line survives only if the WHOLE line is a heading — prose that merely
// mentions 参考文献 must not open a reference section. Printed headings carry
// decoration the anchor would otherwise reject, so each line is stripped down
// first and the whole-line test applied to what remains:
//   参　考　文　献   ·  【参考文献】  ·  〇参考文献  ·  8. 参考文献
//   参考文献・ウェブサイト  ·  参照・参考文献  ·  Sources and References
//   644    参照・参考文献        (a running head, page number and all)
const HEADING_CORE =
	/(?:参考文献|引用文献|参照文献|参考図書|参考資料|引用資料|references?|bibliograph(?:y|ie)|works\s+(?:cited|consulted)|literature\s+cited|reference\s+list|list\s+of\s+references|further\s+reading|литература|список\s+литературы|библиография|literaturverzeichnis|références)/iu;
// Entry-shaped forms. A bibliographic survey of Ainu studies prints lines like
// "1985 文献目録" as content, and the folio stripper would reduce those to a bare
// heading, so they qualify only when nothing was stripped from the line.
const HEADING_CORE_WEAK = /(?:文献目録|文献一覧|文献表|文献)/u;
/** Qualifiers printed before the heading: 主要参考文献, Selected Bibliography. */
const HEADING_PREFIX = /(?:主要|主な|おもな|引用|参照|参考|注|selected|primary|main)/iu;
/** Items a heading is compounded with: 参考文献・ウェブサイト, 参考文献一覧. */
const HEADING_TAIL =
	/(?:一覧|リスト|目録|表|参照|資料|図書|ウェブサイト|web\s*サイト|サイト|url|notes?|cited|consulted|reading|and\s+sources|sources|источники)/iu;
const HEADING_SEPARATOR = /\s*(?:[・、,&＆/／]|および|と|and)?\s*/iu;
/** Leading section numbering: 8. · 8．· 3.2 · 第8章 · II. · (3) */
const LEADING_NUMBER = /^\s*(?:第\s*[0-9０-９一二三四五六七八九十]+\s*[章節部]|[(（]?[0-9０-９]+(?:[.．][0-9０-９]+)*[)）]?|[ivxIVX]+(?=\s*[.．、:：]))\s*[.．、:：]?\s*/u;
/** Decoration around a heading: brackets and bullets. */
const LEADING_MARK = /^[\s　【〔〈《「『（(\[〇○●◆◇■□▲△※＊*#･・~-]+/u;
const TRAILING_MARK = /[\s　】〕〉》」』）)\]：:・~。．.、,-]+$/u;
// An explanatory note appended to the heading — 参照文献(参照ウェブサイトを含む).
// Anchored at end of line: a mid-line parenthesis belongs to prose, and stripping
// from it would reduce a numbered citation such as 文献(3)によると… to bare 文献.
const TRAILING_NOTE = /[（(][^（）()]*[）)]?[\s　]*$/u;

/**
 * Reduce a printed heading to bare vocabulary: drop a running head's page number,
 * section numbering, brackets and bullets, a trailing parenthetical note, and the
 * inter-character spacing that 参　考　文　献 is typeset with.
 */
function normalizeHeadingLine(line: string): { value: string; folioStripped: boolean } {
	let value = line.normalize('NFKC').trim();
	// A running head carries the folio: "644    参照・参考文献" (either side).
	const withoutFolio = value.replace(/^\s*\d{1,4}\s+/u, '').replace(/\s+\d{1,4}\s*$/u, '');
	const folioStripped = withoutFolio !== value;
	// Brackets first, then numbering: 【8. 参考文献】 wears both.
	value = withoutFolio.replace(LEADING_MARK, '').replace(TRAILING_MARK, '');
	value = value.replace(LEADING_NUMBER, '').replace(LEADING_MARK, '');
	value = value.replace(TRAILING_NOTE, '').replace(TRAILING_MARK, '');
	// 参 考 文 献 → 参考文献, while "works cited" keeps its single space.
	value = value.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])[\s　]+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, '');
	return { value: value.replace(/[\s　]+/gu, ' ').trim(), folioStripped };
}

/** `^(qualifier sep)* core (sep (qualifier|core))*$` over the vocabulary above. */
function wholeLinePattern(core: RegExp): RegExp {
	const sep = HEADING_SEPARATOR.source;
	const qualifier = `(?:${HEADING_PREFIX.source}|${HEADING_TAIL.source})`;
	return new RegExp(
		`^(?:${qualifier}${sep})*${core.source}(?:${sep}(?:${qualifier}|${core.source}))*$`,
		'iu'
	);
}

/**
 * True when the line is a bibliography heading and nothing else. The reduced line
 * must be built entirely from heading vocabulary, its qualifiers, and the items a
 * heading is compounded with, so a sentence mentioning 参考文献 is rejected.
 */
export function isReferenceHeading(line: string): boolean {
	const { value, folioStripped } = normalizeHeadingLine(line);
	if (!value || value.length > 40) return false;
	if (wholeLinePattern(HEADING_CORE).test(value)) return true;
	// Bare 文献 qualifies only as printed: allowing it after a folio strip would
	// promote a bibliography entry such as "1985 文献" into a section heading.
	return !folioStripped && wholeLinePattern(HEADING_CORE_WEAK).test(value);
}

/**
 * True when the line ends the reference section. Read through the same reduction
 * as an opening heading, so 【索引】 and `第9章 索引` and a folio-bearing `Appendix A`
 * all close it — an index or appendix left inside the section supplies names, years
 * and titles that would match as citations.
 */
export function isTerminalHeading(line: string): boolean {
	const { value } = normalizeHeadingLine(line);
	if (!value || value.length > 40) return false;
	const sep = HEADING_SEPARATOR.source;
	const whole = new RegExp(
		`^${TERMINAL_CORE.source}(?:${sep}(?:${TERMINAL_CORE.source}|${TERMINAL_TAIL.source}))*$`,
		'iu'
	);
	return whole.test(value);
}

interface ManifestRow {
	path: string;
	source_slug: string;
}

interface CatalogueSource {
	id: string;
	slug: string;
	title: string;
	titleEn: string | null;
	titleAin: string | null;
	altTitles: string[] | null;
	author: string | null;
	yearText: string | null;
	yearStart: number | null;
	type: string;
	category: string;
	region: string | null;
	significance: number | null;
}

interface ReferenceSection {
	heading: string;
	text: string;
}

interface OcrText {
	allPath: string;
	variantDir: string;
	variant: string;
	text: string;
}

export interface CatalogueMatch {
	source: CatalogueSource;
	confidence: 'probable' | 'candidate';
	matchedTitle: string;
	corroboration: ('year' | 'author')[];
	/** Where the matched title occurs in the normalized reference text. */
	spans: { at: number; length: number }[];
}

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index >= 0 && index + 1 < process.argv.length) return process.argv[index + 1];
	const joined = process.argv.find((arg) => arg.startsWith(`${flag}=`));
	return joined?.slice(flag.length + 1);
}

export function normalizeText(value: string): string {
	return value
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, '');
}

export function extractReferenceSection(text: string): ReferenceSection | null {
	const lines = text.split(/\r?\n/u);
	const hits: { index: number; heading: string; key: string }[] = [];
	for (let index = 0; index < lines.length; index++) {
		if (isReferenceHeading(lines[index])) {
			hits.push({
				index,
				heading: lines[index].trim(),
				// Case-folded: a running head printed Bibliography on its first page and
				// BIBLIOGRAPHY thereafter is one heading, and splitting the key would open
				// the section on its second page and lose the first page's references.
				key: normalizeHeadingLine(lines[index]).value.toLowerCase()
			});
		}
	}
	if (hits.length === 0) return null;
	// The last hit is normally the right one: a heading named in the table of
	// contents precedes the section it points at. A heading printed as a running
	// head is the exception — it recurs at page intervals through the bibliography,
	// so its last occurrence is the final page while the section opens at its first.
	//
	// What separates the two is page geometry. A running head recurs once per page,
	// so consecutive hits of the SAME heading land a page of OCR lines apart; a
	// table-of-contents entry sits far from the section it points at, and a heading
	// repeated within a few lines is a duplicate rather than a page header. Hits are
	// therefore grouped into runs only when spaced like pages.
	//
	// The longest run wins, with the latest as tiebreak. Taking simply the latest
	// would hand the section to a lone qualifying heading in an afterword — a
	// further-reading list in a postface is ordinary in Japanese academic books —
	// and lose the whole bibliography behind it.
	const PAGE_MIN = 15;
	const PAGE_MAX = 120;
	const runs: (typeof hits)[] = [];
	for (const hit of hits) {
		const current = runs[runs.length - 1];
		const previous = current?.[current.length - 1];
		const gap = previous ? hit.index - previous.index : Infinity;
		if (previous && previous.key === hit.key && gap >= PAGE_MIN && gap <= PAGE_MAX) {
			current!.push(hit);
		} else {
			runs.push([hit]);
		}
	}
	const best = runs.reduce((a, b) => (b.length >= a.length ? b : a));
	const chosen = best[0];
	const start = chosen.index + 1;
	const heading = chosen.heading;
	let end = lines.length;
	for (let index = start + 3; index < lines.length; index++) {
		if (isTerminalHeading(lines[index])) {
			end = index;
			break;
		}
	}
	// Drop the running heads and folios that fall between pages of the bibliography.
	// They sit mid-entry, and since normalization keeps digits and kanji, a title
	// broken across a page break would otherwise read as
	// "…towarduniversal644参考文献dependenciesforainu…" and match nothing.
	const body = lines
		.slice(start, end)
		.filter((line) => !isReferenceHeading(line) && !/^[\s　]*\d{1,4}[\s　]*$/u.test(line));
	const section = body.join('\n').trim().slice(0, 120_000);
	return section.length >= 40 ? { heading, text: section } : null;
}

function titleAliases(source: CatalogueSource): { display: string; normalized: string }[] {
	const values = [source.title, source.titleEn, source.titleAin, ...(source.altTitles ?? [])];
	const seen = new Set<string>();
	const aliases: { display: string; normalized: string }[] = [];
	for (const display of values) {
		if (!display) continue;
		const normalized = normalizeText(display);
		if (normalized.length < 10 || seen.has(normalized)) continue;
		if (/^[\p{L}\p{N}]{1,6}\d{4}$/u.test(normalized)) continue;
		seen.add(normalized);
		aliases.push({ display, normalized });
	}
	return aliases.sort((a, b) => b.normalized.length - a.normalized.length);
}

function authorKeys(author: string | null): string[] {
	if (!author) return [];
	const chunks = author
		.normalize('NFKC')
		.split(/\s*(?:;|、|&|\band\b|\|)\s*/iu)
		.flatMap((part) => {
			const beforeComma = part.split(',')[0]?.trim();
			const tokens = part.match(/[\p{L}\p{N}]+/gu) ?? [];
			return [beforeComma, tokens[0], tokens.at(-1)];
		})
		.filter((value): value is string => Boolean(value));
	return [...new Set(chunks.map(normalizeText).filter((value) => value.length >= 2))];
}

/**
 * How far either side of a matched title to look for its author and year.
 *
 * Normalization strips every space and mark, so this counts bare letters and digits.
 * Measured over the held bibliographies by the spacing between consecutive year
 * tokens, one entry runs a median of 47 such characters (p75 88). A window that
 * spans several entries reads a NEIGHBOUR's author or year as corroboration, which
 * is how "The Ainu Language" — matched inside Batchelor's printed "A Grammar of the
 * Ainu Language" — was promoted to a public edge credited to Tamura 2000.
 */
const CORROBORATION_WINDOW = 60;

function matchOne(
	sectionNormalized: string,
	source: CatalogueSource,
	corroborationWindow = CORROBORATION_WINDOW
): CatalogueMatch | null {
	// Every occurrence of every alias that appears. A title cited in its own right
	// may ALSO appear inside a longer title elsewhere in the same bibliography, and
	// a work cited under one alias may be nested under another, so stopping at the
	// first alias to hit would discard the occurrence that stands alone.
	const spans: { at: number; length: number }[] = [];
	let matchedTitle: string | undefined;
	for (const alias of titleAliases(source)) {
		let hit = false;
		for (
			let at = sectionNormalized.indexOf(alias.normalized);
			at >= 0;
			at = sectionNormalized.indexOf(alias.normalized, at + 1)
		) {
			spans.push({ at, length: alias.normalized.length });
			hit = true;
		}
		// Aliases come longest-first, so the first one to appear names the match.
		if (hit && matchedTitle === undefined) matchedTitle = alias.display;
	}
	if (matchedTitle === undefined) return null;
	spans.sort((a, b) => a.at - b.at || b.length - a.length);
	// Corroborate each occurrence on its own window and keep the best. Reading only
	// the first would judge the work by a neighbouring entry's year and author
	// whenever that occurrence is the one sitting inside a longer title.
	const keys = authorKeys(source.author);
	let corroboration: ('year' | 'author')[] = [];
	for (const span of spans) {
		const window = sectionNormalized.slice(
			Math.max(0, span.at - corroborationWindow),
			Math.min(sectionNormalized.length, span.at + span.length + corroborationWindow)
		);
		const found: ('year' | 'author')[] = [];
		if (source.yearStart && window.includes(String(source.yearStart))) found.push('year');
		if (keys.some((key) => window.includes(key))) found.push('author');
		if (found.length > corroboration.length) corroboration = found;
		if (corroboration.length === 2) break;
	}
	return {
		source,
		confidence: corroboration.length ? 'probable' : 'candidate',
		matchedTitle,
		corroboration,
		spans
	};
}

/**
 * Drop a match whose title only ever occurs inside a longer matched title. A
 * short title is a substring of longer ones — "The Ainu Language" sits inside
 * Batchelor's "A Grammar of the Ainu Language", and "Universal Dependencies for
 * Ainu" inside "Toward Universal Dependencies for Ainu" — and crediting the
 * shorter work for the longer one's reference invents a citation. A match
 * survives on any single occurrence that stands on its own, so a work genuinely
 * cited elsewhere in the same bibliography keeps its edge.
 */
function withoutSubsumedMatches(matches: CatalogueMatch[]): CatalogueMatch[] {
	return matches.filter((match) =>
		match.spans.some(
			(span) =>
				!matches.some(
					(other) =>
						other !== match &&
						// An uncorroborated host never becomes an edge of its own, so letting
						// it displace a corroborated match would drop a citation and record
						// nothing in its place.
						!(other.confidence === 'candidate' && match.confidence === 'probable') &&
						other.spans.some(
							(host) =>
								host.length > span.length &&
								host.at <= span.at &&
								host.at + host.length >= span.at + span.length
						)
				)
		)
	);
}

function duplicateKey(match: CatalogueMatch): string {
	return `${match.source.yearStart ?? 'nd'}\t${normalizeText(match.source.title)}`;
}

/** Choose between two catalogue records held for the same work. */
function matchRank(match: CatalogueMatch): number {
	const confidence = match.confidence === 'probable' ? 1_000_000 : 0;
	// Which of two records for one work the rest of the catalogue already treats as
	// the real one. This reads `significance`, the PageRank over the very edges this
	// sweep feeds, so a refresh between runs can change the winner — see the header
	// note on running the refresh before the sweep. Substitutes were measured and
	// were worse: ranking by slug picks the shorter stub over
	// 1996-tamura-ainu-saru-dialect-dictionary, and ranking by metadata richness
	// picks corpus-derived records that carry an entry count over the bibliographic
	// record a citation actually means.
	const significance = Math.round((match.source.significance ?? 0) * 100_000);
	const stubPenalty = /[（(]\d{4}[）)]$/u.test(match.source.title) ? -10_000 : 0;
	return confidence + significance + stubPenalty + normalizeText(match.matchedTitle).length;
}

/** Deterministic order for records nothing above separates. */
function tieBreak(a: CatalogueMatch, b: CatalogueMatch): number {
	return a.source.slug.localeCompare(b.source.slug);
}

export function findCatalogueMatches(
	referenceText: string,
	catalogue: CatalogueSource[],
	citingSlug: string,
	corroborationWindow = CORROBORATION_WINDOW
): CatalogueMatch[] {
	const sectionNormalized = normalizeText(referenceText);
	const byWork = new Map<string, CatalogueMatch>();
	for (const source of catalogue) {
		if (source.slug === citingSlug) continue;
		const match = matchOne(sectionNormalized, source, corroborationWindow);
		if (!match) continue;
		const key = duplicateKey(match);
		const previous = byWork.get(key);
		if (!previous) {
			byWork.set(key, match);
			continue;
		}
		const better = matchRank(match) - matchRank(previous) || tieBreak(previous, match);
		if (better > 0) byWork.set(key, match);
	}
	return withoutSubsumedMatches([...byWork.values()]).sort((a, b) => {
		const ay = a.source.yearStart ?? 9999;
		const by = b.source.yearStart ?? 9999;
		return ay - by || a.source.author?.localeCompare(b.source.author ?? '') || a.source.title.localeCompare(b.source.title);
	});
}

function ocrDirectory(ocrRoot: string, pdfPath: string): string {
	return path.join(ocrRoot, pdfPath.replace(/\.pdf$/iu, '.ocr'));
}

function selectOcrText(directory: string): OcrText | null {
	if (!fs.existsSync(directory)) return null;
	const variants = fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, 'all.txt')))
		.map((entry) => entry.name)
		.sort((a, b) => {
			const rank = (name: string) =>
				name.startsWith('openrouter_') ? 0 : name === 'pdftotext' ? 2 : 1;
			return rank(a) - rank(b) || a.localeCompare(b);
		});
	if (!variants.length) return null;
	const variant = variants[0];
	const variantDir = path.join(directory, variant);
	const allPath = path.join(variantDir, 'all.txt');
	return { allPath, variantDir, variant, text: fs.readFileSync(allPath, 'utf8') };
}

function scanPageRange(variantDir: string): string | undefined {
	const pages = fs
		.readdirSync(variantDir)
		.filter((name) => /^page-\d+\.txt$/u.test(name))
		.sort();
	if (!pages.length) return undefined;
	let first: number | undefined;
	let last: number | undefined;
	for (const name of pages) {
		const text = fs.readFileSync(path.join(variantDir, name), 'utf8');
		const number = Number(name.match(/\d+/u)?.[0]);
		if (first === undefined && text.split(/\r?\n/u).some(isReferenceHeading)) first = number;
		if (first !== undefined) last = number;
	}
	return first === undefined || last === undefined ? undefined : `scan pp. ${first}-${last}`;
}

function inferTitle(pdfPath: string): string {
	return path
		.basename(pdfPath, path.extname(pdfPath))
		.replace(/^\d{4}[_ -]*/u, '')
		.replace(/_/gu, ' ');
}

function inferYear(pdfPath: string): number | undefined {
	const match = path.basename(pdfPath).match(/^(1[0-9]{3}|20[0-9]{2})/u);
	return match ? Number(match[1]) : undefined;
}

function splitAuthors(author: string | null): string[] {
	return author ? [author] : [];
}

async function main() {
	const dbUrl = argValue('--db') ?? process.env.DATABASE_URL;
	if (!dbUrl) throw new Error('DATABASE_URL or --db is required');
	const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
	const projectRoot = process.env.AINU_ROOT;
	const ocrRoot =
		argValue('--ocr-root') ?? (projectRoot ? path.join(projectRoot, 'ainu-grammar') : path.resolve('..', 'ainu-grammar'));
	const manifestPath =
		argValue('--manifest') ??
		(projectRoot
			? path.join(projectRoot, 'ainu-archive', '.archive', 'manifest-ainu-grammar.jsonl')
			: path.resolve('..', 'ainu-archive', '.archive', 'manifest-ainu-grammar.jsonl'));
	const outputDir =
		argValue('--output') ?? path.join(import.meta.dir, 'data', 'extracted-cites', 'generated');

	const db = openDb(dbUrl, authToken);
	const catalogue: CatalogueSource[] = await db
		.select({
			id: sources.id,
			slug: sources.slug,
			title: sources.title,
			titleEn: sources.titleEn,
			titleAin: sources.titleAin,
			altTitles: sources.altTitles,
			author: sources.author,
			yearText: sources.yearText,
			yearStart: sources.yearStart,
			type: sources.type,
			category: sources.category,
			region: sources.region,
			significance: sources.significance
		})
		.from(sources)
		.where(eq(sources.status, ACTIVE_SOURCE_STATUS));
	const bySlug = new Map(catalogue.map((source) => [source.slug, source]));
	const manifest: ManifestRow[] = fs
		.readFileSync(manifestPath, 'utf8')
		.trim()
		.split(/\r?\n/u)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ManifestRow);

	fs.mkdirSync(outputDir, { recursive: true });
	const written = new Set<string>();
	let ocrAvailable = 0;
	let referenceSections = 0;
	let probable = 0;
	let candidate = 0;
	let worksWithMatches = 0;

	for (const row of manifest) {
		const ocr = selectOcrText(ocrDirectory(ocrRoot, row.path));
		if (!ocr) continue;
		ocrAvailable += 1;
		const section = extractReferenceSection(ocr.text);
		if (!section) continue;
		referenceSections += 1;
		const matches = findCatalogueMatches(section.text, catalogue, row.source_slug);
		if (!matches.length) continue;
		worksWithMatches += 1;
		probable += matches.filter((match) => match.confidence === 'probable').length;
		candidate += matches.filter((match) => match.confidence === 'candidate').length;
		const citing = bySlug.get(row.source_slug);
		const year = citing?.yearStart ?? inferYear(row.path);
		const data = {
			schema: GENERATED_SCHEMA,
			verified: false,
			citingWork: {
				slug: row.source_slug,
				title: citing?.title ?? inferTitle(row.path),
				author: citing?.author ?? undefined,
				year,
				type: citing?.type ?? 'publication'
			},
			extraction: {
				textSource: `OCR variant ${ocr.variant}`,
				referenceHeading: section.heading,
				referencePages: scanPageRange(ocr.variantDir),
				referenceCount: matches.length,
				sourcePath: row.path
			},
			references: matches.map((match, index) => ({
				n: index + 1,
				authors: splitAuthors(match.source.author),
				year: match.source.yearStart ?? undefined,
				yearText: match.source.yearText ?? undefined,
				title: match.source.title,
				titleEn: match.source.titleEn ?? undefined,
				type: match.source.type,
				// `ainuRelated` is deliberately absent. It records whether a work belongs in
				// this Ainu-focused catalogue — a curation judgement the sweep does not make,
				// since all it reports is that a catalogued title occurs in a bibliography.
				// The field previously carried `Boolean(source.region)`, a geographic column
				// null on most records, and so marked catalogued Ainu scholarship unrelated.
				match: {
					slug: match.source.slug,
					confidence: match.confidence,
					note: `Title match${match.corroboration.length ? `; corroborated by ${match.corroboration.join(' + ')}` : ''}`
				},
				matchedTitle: match.matchedTitle
			}))
		};
		const filename = `${row.source_slug}.json`;
		fs.writeFileSync(path.join(outputDir, filename), `${JSON.stringify(data, null, 2)}\n`);
		written.add(filename);
	}

	for (const filename of fs.readdirSync(outputDir)) {
		if (filename.endsWith('.json') && !written.has(filename)) fs.unlinkSync(path.join(outputDir, filename));
	}

	console.log(
		`reference sweep: ${manifest.length} archive works; ${ocrAvailable} OCR texts; ` +
			`${referenceSections} reference sections; ${worksWithMatches} matched works`
	);
	console.log(`citation matches: ${probable} probable; ${candidate} candidate; ${probable + candidate} total`);
	console.log(`wrote ${written.size} datasets to ${path.relative(process.cwd(), outputDir)}`);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	});
}
