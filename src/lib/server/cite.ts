// ---------------------------------------------------------------------------
// Citation export — one normalized model, many formats.
//
// Every export endpoint (BibTeX, CSL-JSON, Hayagriva YAML, RIS) builds the SAME
// `CitationData` from a SourceDetail, then serializes it. This keeps the formats
// consistent and lets us enrich them all at once (venue→container, editor /
// translator roles, DOI, archive + call number, language).
// ---------------------------------------------------------------------------
import type { SourceDetail } from '$lib/types';
import { asArray } from '$lib/format';

export interface CitationData {
	/** url slug (stable id / Hayagriva key) */
	slug: string;
	/** BibTeX/RIS-safe key (alphanumerics only) */
	key: string;
	/** our internal source.type */
	type: string;
	title: string;
	titleEn?: string;
	authors: string[];
	editors: string[];
	translators: string[];
	year?: number;
	yearEnd?: number;
	yearText?: string;
	/** journal / series / container title (academic sources only) */
	venue?: string;
	publisher?: string;
	doi?: string;
	url?: string;
	/** holding institution → archive */
	archive?: string;
	/** call number → archive-location */
	archiveLocation?: string;
	/** primary language code (ain, jpn, …) */
	language?: string;
	dialect?: string;
}

// Provenance repos whose `summary` field carries a venue (journal / publisher),
// as opposed to catalog sources where `summary` is a free-text description.
const ACADEMIC_REPOS = new Set([
	'openalex', 'crossref', 'cinii', 'openlibrary', 'ndl', 'cyberleninka', 'togo', 'hoppodb', 'sgu'
]);

const cleanDoi = (raw: string | undefined | null): string | undefined => {
	if (!raw) return undefined;
	const d = String(raw).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase();
	return d || undefined;
};

/** Group the source's people into author / editor / translator buckets. */
function partitionPeople(persons: SourceDetail['persons']) {
	const authors: string[] = [];
	const editors: string[] = [];
	const translators: string[] = [];
	for (const p of persons) {
		const name = p.name?.trim();
		if (!name) continue;
		switch (p.role) {
			case 'editor':
			case 'compiler':
			case 'transcriber':
				editors.push(name);
				break;
			case 'translator':
				translators.push(name);
				break;
			default: // author, recorder, speaker, researcher, …
				authors.push(name);
		}
	}
	return { authors, editors, translators };
}

export function buildCitation(detail: SourceDetail, slug: string): CitationData {
	const { source, persons, links, institutions } = detail;
	const { authors, editors, translators } = partitionPeople(persons);
	if (!authors.length && source.author) authors.push(source.author);

	const isAcademic = ACADEMIC_REPOS.has(source.provenanceRepo);
	const venue = isAcademic && source.summary ? source.summary.trim() : undefined;

	const doi = cleanDoi(source.externalIds?.doi);
	// Holding institution from the joined refs (preferred) or the free-text field.
	const holding =
		institutions.find((i) => i.role === 'holding')?.name ?? source.holdingInstitution ?? undefined;

	const url = links[0]?.url ?? (doi ? `https://doi.org/${doi}` : undefined);

	return {
		slug,
		key: slug.replace(/[^a-zA-Z0-9]/g, ''),
		type: source.type,
		title: source.title,
		titleEn: source.titleEn && source.titleEn !== source.title ? source.titleEn : undefined,
		authors,
		editors,
		translators,
		year: source.yearStart ?? undefined,
		yearEnd: source.yearEnd ?? undefined,
		yearText: source.yearText ?? undefined,
		venue,
		publisher: undefined,
		doi,
		url,
		archive: holding ?? undefined,
		archiveLocation: source.callNumber ?? undefined,
		language: asArray(source.languages)[0],
		dialect: source.dialect ?? undefined
	};
}

/** Title with the English title appended in brackets, when present. */
function fullTitle(c: CitationData): string {
	return c.titleEn ? `${c.title} (${c.titleEn})` : c.title;
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------
function escapeBibtex(value: string): string {
	return value
		.replace(/\\/g, '\\textbackslash{}')
		.replace(/([&%$#_{}])/g, '\\$1')
		.replace(/~/g, '\\textasciitilde{}')
		.replace(/\^/g, '\\textasciicircum{}');
}

function bibtexType(type: string): string {
	if (type === 'article') return 'article';
	if (type === 'book-chapter') return 'incollection';
	if (type === 'thesis') return 'phdthesis';
	if (/^(grammar|book|dictionary|wordlist|glossary|workbook|old-document|bibliography)/.test(type))
		return 'book';
	return 'misc'; // corpus/dataset/model/software/website/video
}

export function toBibtex(c: CitationData): string {
	const entryType = bibtexType(c.type);
	const fields: [string, string][] = [];
	const push = (k: string, v: string | undefined) => {
		if (v) fields.push([k, escapeBibtex(v)]);
	};
	push('title', fullTitle(c));
	if (c.authors.length) push('author', c.authors.join(' and '));
	if (c.editors.length) push('editor', c.editors.join(' and '));
	if (c.year != null) push('year', String(c.year));
	if (entryType === 'article' && c.venue) push('journal', c.venue);
	if (entryType === 'incollection' && c.venue) push('booktitle', c.venue);
	push('doi', c.doi);
	push('language', c.language);
	push('note', c.dialect);
	if (c.url) push(entryType === 'misc' ? 'howpublished' : 'url', c.url);

	const body = fields.map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
	return `@${entryType}{${c.key},\n${body}\n}\n`;
}

// ---------------------------------------------------------------------------
// CSL-JSON
// ---------------------------------------------------------------------------
function cslType(type: string): string {
	if (type === 'article') return 'article-journal';
	if (type === 'book-chapter') return 'chapter';
	if (type === 'thesis') return 'thesis';
	if (/^(grammar|book|dictionary|wordlist|glossary|workbook|bibliography)/.test(type)) return 'book';
	if (type === 'corpus-text' || type === 'dataset') return 'dataset';
	if (type === 'software' || type === 'model') return 'software';
	if (type === 'web-article') return 'post-weblog';
	if (type === 'website') return 'webpage';
	return 'manuscript'; // old-document & friends
}

export function toCSL(c: CitationData): Record<string, unknown> {
	const names = (xs: string[]) => xs.map((n) => ({ literal: n }));
	const item: Record<string, unknown> = {
		id: c.slug,
		type: cslType(c.type),
		title: c.title,
		author: c.authors.length ? names(c.authors) : undefined,
		editor: c.editors.length ? names(c.editors) : undefined,
		translator: c.translators.length ? names(c.translators) : undefined,
		'container-title': c.venue,
		issued: c.year != null ? { 'date-parts': [[c.year]] } : undefined,
		DOI: c.doi,
		URL: c.url,
		archive: c.archive,
		archive_location: c.archiveLocation,
		language: c.language,
		'title-short': c.titleEn,
		note: c.dialect ?? undefined
	};
	for (const k of Object.keys(item)) if (item[k] === undefined) delete item[k];
	return item;
}

// ---------------------------------------------------------------------------
// Hayagriva YAML (Typst's bibliography format)
// ---------------------------------------------------------------------------
function hayagrivaType(type: string): string {
	if (type === 'article') return 'article';
	if (type === 'book-chapter') return 'chapter';
	if (type === 'thesis') return 'thesis';
	if (/^(grammar|book|dictionary|wordlist|glossary|workbook|bibliography)/.test(type)) return 'book';
	if (type === 'old-document') return 'manuscript';
	if (type === 'corpus-text' || type === 'dataset') return 'misc';
	if (type === 'software' || type === 'model') return 'repository';
	if (type === 'web-article') return 'blog';
	if (type === 'website') return 'web';
	if (type === 'video') return 'video';
	return 'misc';
}

/** Double-quote + escape a scalar for YAML. */
function yamlStr(s: string): string {
	return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function toHayagriva(c: CitationData): string {
	const lines: string[] = [];
	const ind = (n: number) => '  '.repeat(n);
	// People as a YAML block list of names.
	const people = (label: string, xs: string[], depth: number) => {
		if (!xs.length) return;
		lines.push(`${ind(depth)}${label}:`);
		for (const x of xs) lines.push(`${ind(depth + 1)}- ${yamlStr(x)}`);
	};

	lines.push(`${c.slug}:`);
	lines.push(`${ind(1)}type: ${hayagrivaType(c.type)}`);
	lines.push(`${ind(1)}title: ${yamlStr(fullTitle(c))}`);
	people('author', c.authors, 1);
	people('editor', c.editors, 1);
	people('translator', c.translators, 1);
	if (c.year != null) lines.push(`${ind(1)}date: ${c.year}`);
	// A journal article / chapter hangs off a parent container.
	if (c.venue && (c.type === 'article' || c.type === 'book-chapter')) {
		lines.push(`${ind(1)}parent:`);
		lines.push(`${ind(2)}type: ${c.type === 'article' ? 'periodical' : 'anthology'}`);
		lines.push(`${ind(2)}title: ${yamlStr(c.venue)}`);
	} else if (c.venue) {
		lines.push(`${ind(1)}publisher: ${yamlStr(c.venue)}`);
	}
	if (c.archive) lines.push(`${ind(1)}archive: ${yamlStr(c.archive)}`);
	if (c.archiveLocation) lines.push(`${ind(1)}archive-location: ${yamlStr(c.archiveLocation)}`);
	if (c.doi) {
		lines.push(`${ind(1)}serial-number:`);
		lines.push(`${ind(2)}doi: ${yamlStr(c.doi)}`);
	}
	if (c.url) lines.push(`${ind(1)}url: ${yamlStr(c.url)}`);
	if (c.language) lines.push(`${ind(1)}language: ${yamlStr(c.language)}`);
	if (c.dialect) lines.push(`${ind(1)}note: ${yamlStr(c.dialect)}`);
	return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// RIS (EndNote / Zotero / Mendeley import format)
// ---------------------------------------------------------------------------
function risType(type: string): string {
	if (type === 'article') return 'JOUR';
	if (type === 'book-chapter') return 'CHAP';
	if (type === 'thesis') return 'THES';
	if (/^(grammar|book|dictionary|wordlist|glossary|workbook|bibliography)/.test(type)) return 'BOOK';
	if (type === 'old-document') return 'MANSCPT';
	if (type === 'corpus-text' || type === 'dataset') return 'DATA';
	if (type === 'software' || type === 'model') return 'COMP';
	if (type === 'web-article' || type === 'website') return 'ELEC';
	return 'GEN';
}

export function toRIS(c: CitationData): string {
	const lines: string[] = [];
	const tag = (t: string, v: string | undefined) => {
		if (v) lines.push(`${t}  - ${v}`);
	};
	lines.push(`TY  - ${risType(c.type)}`);
	tag('TI', fullTitle(c));
	for (const a of c.authors) tag('AU', a);
	for (const e of c.editors) tag('A2', e);
	for (const tr of c.translators) tag('A4', tr);
	if (c.year != null) tag('PY', String(c.year));
	if (c.type === 'article') tag('JO', c.venue);
	else if (c.type === 'book-chapter') tag('T2', c.venue);
	else tag('PB', c.venue);
	tag('DO', c.doi);
	tag('UR', c.url);
	tag('LA', c.language);
	tag('AN', c.archiveLocation);
	tag('N1', c.dialect);
	lines.push('ER  - ');
	return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Plain-text reference (human-readable, copy-to-clipboard)
// ---------------------------------------------------------------------------
export function toReference(c: CitationData): string {
	const parts: string[] = [];
	if (c.authors.length) parts.push(c.authors.join(', '));
	const yr = c.yearText || (c.year != null ? String(c.year) : '');
	let head = parts.join('');
	if (yr) head += head ? ` (${yr}).` : `(${yr}).`;
	const segs: string[] = [];
	if (head) segs.push(head);
	segs.push(fullTitle(c) + '.');
	if (c.venue) segs.push(c.venue + '.');
	if (c.editors.length) segs.push(`Ed. ${c.editors.join(', ')}.`);
	if (c.doi) segs.push(`https://doi.org/${c.doi}`);
	else if (c.url) segs.push(c.url);
	return segs.join(' ').replace(/\s+/g, ' ').trim();
}
