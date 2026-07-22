#!/usr/bin/env bun
/**
 * Scan every locally available OCR text for a terminal bibliography, resolve
 * title mentions against the ainu-sources catalogue, and write reviewable
 * extracted-cites/v1 datasets under scripts/data/extracted-cites/generated/.
 *
 * The sweep is deliberately conservative:
 *   • it searches only text after a bibliography/reference heading;
 *   • a catalogue title/alternate title must occur as a normalized substring;
 *   • year or author corroboration makes a match `probable`;
 *   • title-only matches remain `candidate`;
 *   • no new source record is proposed from OCR.
 *
 * The generated files are consumed by scripts/import/extracted-cites.ts.
 * Probable matches become accepted citation edges. Candidate matches are stored
 * as candidate edges, outside the public network and PageRank calculation.
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

const REFERENCE_HEADING =
	/^\s*(references|bibliography|works\s+cited|literature\s+cited|reference\s+list|参考文献|引用文献|主要参考文献|参照文献|文\s*献|литература|список\s+литературы|библиография|literaturverzeichnis|références)\s*$/imu;
const TERMINAL_HEADING =
	/^\s*(appendix|appendices|index|about\s+the\s+author|author\s+biography|付録|附録|索引|著者紹介)\s*$/imu;
const GENERATED_SCHEMA = 'extracted-cites/v1';

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
	let start = -1;
	let heading = '';
	for (let index = 0; index < lines.length; index++) {
		if (REFERENCE_HEADING.test(lines[index])) {
			start = index + 1;
			heading = lines[index].trim();
		}
	}
	if (start < 0) return null;
	let end = lines.length;
	for (let index = start + 3; index < lines.length; index++) {
		if (TERMINAL_HEADING.test(lines[index])) {
			end = index;
			break;
		}
	}
	const section = lines.slice(start, end).join('\n').trim().slice(0, 120_000);
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

function matchOne(sectionNormalized: string, source: CatalogueSource): CatalogueMatch | null {
	for (const alias of titleAliases(source)) {
		const index = sectionNormalized.indexOf(alias.normalized);
		if (index < 0) continue;
		const window = sectionNormalized.slice(
			Math.max(0, index - 180),
			Math.min(sectionNormalized.length, index + alias.normalized.length + 180)
		);
		const corroboration: ('year' | 'author')[] = [];
		if (source.yearStart && window.includes(String(source.yearStart))) corroboration.push('year');
		if (authorKeys(source.author).some((key) => window.includes(key))) corroboration.push('author');
		return {
			source,
			confidence: corroboration.length ? 'probable' : 'candidate',
			matchedTitle: alias.display,
			corroboration
		};
	}
	return null;
}

function duplicateKey(match: CatalogueMatch): string {
	return `${match.source.yearStart ?? 'nd'}\t${normalizeText(match.source.title)}`;
}

function matchRank(match: CatalogueMatch): number {
	const confidence = match.confidence === 'probable' ? 1_000_000 : 0;
	const significance = Math.round((match.source.significance ?? 0) * 100_000);
	const stubPenalty = /[（(]\d{4}[）)]$/u.test(match.source.title) ? -10_000 : 0;
	return confidence + significance + stubPenalty + normalizeText(match.matchedTitle).length;
}

export function findCatalogueMatches(
	referenceText: string,
	catalogue: CatalogueSource[],
	citingSlug: string
): CatalogueMatch[] {
	const sectionNormalized = normalizeText(referenceText);
	const byWork = new Map<string, CatalogueMatch>();
	for (const source of catalogue) {
		if (source.slug === citingSlug) continue;
		const match = matchOne(sectionNormalized, source);
		if (!match) continue;
		const key = duplicateKey(match);
		const previous = byWork.get(key);
		if (!previous || matchRank(match) > matchRank(previous)) byWork.set(key, match);
	}
	return [...byWork.values()].sort((a, b) => {
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
		if (REFERENCE_HEADING.test(text) && first === undefined) first = number;
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
				ainuRelated: Boolean(match.source.region),
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
