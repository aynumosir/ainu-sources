import { and, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { ocrIngestState, revisionOcrCoverage } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { ArchiveHttpError } from './errors';
import { decodePageCursor, decodeSearchCursor, encodePageCursor, encodeSearchCursor } from './cursor';
import { archiveSearchVisibilitySql } from './gateway';
import {
	escapeFtsLiteral,
	expandNormalizedTokenAlternatives,
	literalPhraseAlternatives,
	normalizeOcrText,
	OCR_NORMALIZATION_VERSION,
	tokenizeNormalizedText
} from './search-normalization';
import { compileLinearRegex, extractRegexLiterals, parseRegexAst, RegexSyntaxError } from './linear-regex';
import type { SearchMode, SearchTolerance } from './search-modes';
import type { ArchivePrincipal } from './types';

type Db = LibSQLDatabase<typeof schema>;
type RawSqlDb = Pick<Db, 'run' | 'all'>;

export type OcrPageInput = { page: number; text: string };
export type OcrPageRow = { revisionId: string; variant: string; page: number; text: string };

type RankedChunk = {
	chunkId: string;
	revisionId: string;
	variant: string;
	page: number;
	block: number;
	text: string;
	textNorm: string;
	rank: number;
	sourceSlug: string;
	sourceTitle: string;
	sourceTitleEn: string | null;
	sourceTitleAin: string | null;
	sourceAuthor: string | null;
	sourceYearText: string | null;
	sourceYearStart: number | null;
	sourceYearEnd: number | null;
	sourceYearCertainty: string | null;
};

const DEFAULT_TEXT_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
export const SEARCH_INTERNAL_CAP = 1000;
const REGEX_CANDIDATE_CAP = 500;
const REGEX_TIME_BUDGET_MS = 40;
const SOFT_LEXICON_CAP = 2000;
const SOFT_OCCURRENCE_CAP = 3000;
// Candidate chunks scanned in memory per soft query. Each one is tokenized
// and compared against the query, so this bounds the request's CPU cost.
const SOFT_CHUNK_SCAN_CAP = 90;
// Text extracted without page structure lands in a single chunk, and the
// largest in this collection is a whole book of about 15 MB. Tokenizing that
// is what made fuzzy search take tens of seconds, so each chunk contributes a
// bounded prefix and the total scanned across a query is bounded too.
const SOFT_CHUNK_CHAR_CAP = 120_000;
const SOFT_TOTAL_CHAR_CAP = 1_200_000;
const SIMILAR_CANDIDATE_CAP = 30;
// A whole-document reference (page 0) can be an entire book. Comparing every
// token of it against every candidate exceeds the request budget, so the
// reference is truncated to a representative window.
const SIMILAR_REFERENCE_TOKEN_CAP = 400;
const SIMILAR_REFERENCE_CHAR_CAP = 4000;

export async function searchArchive(
	db: Db,
	principal: ArchivePrincipal,
	opts: {
		q: string;
		mode: SearchMode;
		tolerance?: SearchTolerance;
		cursor?: string | null;
		sourceSlug?: string | null;
		variant?: string | null;
		maxChars?: number;
		limit?: number;
	}
) {
	if (opts.mode === 'semantic') return semanticUnavailable();
	if (opts.mode === 'regex') return searchRegex(db, principal, opts);
	if (opts.mode === 'soft') return searchSoft(db, principal, opts);
	if (opts.mode === 'similar') return searchSimilar(db, principal, opts);
	return searchOcr(db, principal, opts);
}

export function parsePageSelector(value: string | null): number[] | null {
	if (value == null || value === '') return null;
	const pages = new Set<number>();
	for (const part of value.split(',')) {
		const single = /^(\d+)$/u.exec(part);
		if (single) {
			pages.add(Number(single[1]));
			continue;
		}
		const range = /^(\d+)-(\d+)$/u.exec(part);
		if (!range) throw new ArchiveHttpError(400, 'invalid pages selector');
		const start = Number(range[1]);
		const end = Number(range[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
			throw new ArchiveHttpError(400, 'invalid pages selector');
		}
		for (let page = start; page <= end; page += 1) pages.add(page);
	}
	return [...pages].sort((a, b) => a - b);
}

const INGEST_BATCH_ROWS = 800;

export async function replaceOcrPages(
	db: Db,
	revisionId: string,
	variant: string,
	pages: OcrPageInput[],
	opts: { contentHash?: string; ingestedAt?: Date } = {}
): Promise<string> {
	// Rows are tagged with a fresh generation and are invisible to readers
	// until the state row flips at the end, so this deliberately runs outside
	// a transaction: holding a write lock across a whole work starves reads on
	// the shared database.
	return activateOcrGeneration(db as unknown as RawSqlDb, revisionId, variant, pages, opts);
}

export async function activateOcrGeneration(
	db: RawSqlDb,
	revisionId: string,
	variant: string,
	pages: OcrPageInput[],
	opts: { contentHash?: string; ingestedAt?: Date } = {}
): Promise<string> {
	const generation = crypto.randomUUID();
	// Rows are written in multi-value batches. One statement per row costs one
	// network round trip against the hosted database, which makes a full
	// corpus ingest take hours; batching keeps it to minutes.
	const chunkRows: SQL[] = [];
	const tokenRows: SQL[] = [];
	// A bulk backfill competes with live reads on the shared database. The
	// pause is opt-in (INGEST_THROTTLE_MS) so a batch ingest can yield between
	// writes; interactive saves leave it unset and pay nothing.
	const throttleMs = Number(globalThis.process?.env?.INGEST_THROTTLE_MS ?? 0) || 0;
	const flush = async (rows: SQL[], statement: (values: SQL) => SQL, force = false) => {
		if (!rows.length || (!force && rows.length < INGEST_BATCH_ROWS)) return;
		await db.run(statement(sql.join(rows, sql`, `)));
		rows.length = 0;
		if (throttleMs > 0) await new Promise((resolve) => setTimeout(resolve, throttleMs));
	};
	const chunkStatement = (values: SQL) => sql`
		insert into ocr_chunks (
			chunk_id, revision_id, variant, page, block, text, text_norm,
			checksum, normalization_version, ingest_generation
		) values ${values}
	`;
	const tokenStatement = (values: SQL) => sql`
		insert into ocr_tokens (
			token_norm, revision_id, variant, page, block, position, chunk_id, ingest_generation
		) values ${values}
	`;
	for (const page of pages) {
		const blocks = splitPageBlocks(page.text);
		for (const [block, original] of blocks.entries()) {
			const text = original.normalize('NFC');
			const textNorm = normalizeOcrText(text);
			const chunkId = `${generation}:${page.page}:${block}`;
			const checksum = await sha256Hex(text);
			chunkRows.push(sql`(
				${chunkId}, ${revisionId}, ${variant}, ${page.page}, ${block}, ${text}, ${textNorm},
				${checksum}, ${OCR_NORMALIZATION_VERSION}, ${generation}
			)`);
			await flush(chunkRows, chunkStatement);
			// One row per distinct token per chunk, at its first position: the
			// index answers "does this chunk contain this token", so repeated
			// words do not need repeated rows.
			const firstPosition = new Map<string, number>();
			for (const token of tokenizeNormalizedText(text)) {
				if (firstPosition.has(token.token)) continue;
				firstPosition.set(token.token, token.position);
			}
			for (const [tokenNorm, position] of firstPosition) {
				tokenRows.push(sql`(
					${tokenNorm}, ${revisionId}, ${variant}, ${page.page}, ${block}, ${position}, ${chunkId}, ${generation}
				)`);
				if (tokenRows.length >= INGEST_BATCH_ROWS) {
					// Tokens reference their chunk, so pending chunks must land first.
					await flush(chunkRows, chunkStatement, true);
					await flush(tokenRows, tokenStatement, true);
				}
			}
		}
	}
	await flush(chunkRows, chunkStatement, true);
	await flush(tokenRows, tokenStatement, true);
	const contentHash = opts.contentHash ?? (await sha256Hex(JSON.stringify(pages)));
	const ingestedAt = opts.ingestedAt ?? new Date();
	await db.run(sql`
		insert into ocr_ingest_state (
			revision_id, variant, content_hash, page_count, active_generation, ingested_at
		) values (
			${revisionId}, ${variant}, ${contentHash}, ${pages.length}, ${generation}, ${ingestedAt}
		)
		on conflict (revision_id, variant) do update set
			content_hash = excluded.content_hash,
			page_count = excluded.page_count,
			active_generation = excluded.active_generation,
			ingested_at = excluded.ingested_at
	`);
	await db.run(sql`
		delete from ocr_chunks
		where revision_id = ${revisionId}
			and variant = ${variant}
			and ingest_generation <> ${generation}
	`);
	return generation;
}

/**
 * Replace one page of the `edited` variant in the search index. The workspace
 * calls this inside its save transaction so a corrected page is searchable
 * immediately, rather than waiting for the next full ingest.
 */
export async function replaceEditedPageChunks(
	db: RawSqlDb,
	revisionId: string,
	page: number,
	text: string | null
): Promise<void> {
	const variant = 'edited';
	const [state] = await db.all<{ generation: string; pageCount: number }>(sql`
		select active_generation as generation, page_count as pageCount
		from ocr_ingest_state
		where revision_id = ${revisionId} and variant = ${variant}
		limit 1
	`);
	const generation = state?.generation ?? crypto.randomUUID();
	await db.run(sql`
		delete from ocr_tokens
		where revision_id = ${revisionId} and variant = ${variant}
			and page = ${page} and ingest_generation = ${generation}
	`);
	await db.run(sql`
		delete from ocr_chunks
		where revision_id = ${revisionId} and variant = ${variant}
			and page = ${page} and ingest_generation = ${generation}
	`);
	if (text != null) {
		for (const [block, original] of splitPageBlocks(text).entries()) {
			const blockText = original.normalize('NFC');
			const textNorm = normalizeOcrText(blockText);
			const chunkId = `${generation}:${page}:${block}`;
			const checksum = await sha256Hex(blockText);
			await db.run(sql`
				insert into ocr_chunks (
					chunk_id, revision_id, variant, page, block, text, text_norm,
					checksum, normalization_version, ingest_generation
				) values (
					${chunkId}, ${revisionId}, ${variant}, ${page}, ${block}, ${blockText}, ${textNorm},
					${checksum}, ${OCR_NORMALIZATION_VERSION}, ${generation}
				)
			`);
			for (const token of tokenizeNormalizedText(blockText)) {
				await db.run(sql`
					insert into ocr_tokens (
						token_norm, revision_id, variant, page, block, position, chunk_id, ingest_generation
					) values (
						${token.token}, ${revisionId}, ${variant}, ${page}, ${block}, ${token.position}, ${chunkId}, ${generation}
					)
				`);
			}
		}
	}
	const [{ maxPage = 0 } = { maxPage: 0 }] = await db.all<{ maxPage: number }>(sql`
		select coalesce(max(page), 0) as maxPage
		from ocr_chunks
		where revision_id = ${revisionId} and variant = ${variant} and ingest_generation = ${generation}
	`);
	await db.run(sql`
		insert into ocr_ingest_state (
			revision_id, variant, content_hash, page_count, active_generation, ingested_at
		) values (
			${revisionId}, ${variant}, ${await sha256Hex(`workspace-edits:${revisionId}:${generation}`)}, ${maxPage}, ${generation}, ${new Date()}
		)
		on conflict (revision_id, variant) do update set
			page_count = excluded.page_count,
			active_generation = excluded.active_generation,
			ingested_at = excluded.ingested_at
	`);
}

export async function listOcrPages(db: RawSqlDb, revisionId: string, variant: string): Promise<OcrPageRow[]> {
	return db.all<OcrPageRow>(sql`
		select revisionId, variant, cast(page as integer) as page, group_concat(text, char(10) || char(10)) as text
		from (
			select c.revision_id as revisionId, c.variant, cast(c.page as integer) as page, c.block, c.text
			from ocr_chunks c
			inner join ocr_ingest_state state
				on state.revision_id = c.revision_id
				and state.variant = c.variant
				and state.active_generation = c.ingest_generation
			where c.revision_id = ${revisionId} and c.variant = ${variant}
			order by c.page, c.block
		)
		group by revisionId, variant, page
		order by page
	`);
}

export async function getRevisionText(
	db: Db,
	revisionId: string,
	pageCount: number | null,
	opts: { variant?: string | null; pages?: string | null; cursor?: string | null; limit?: number } = {}
) {
	const selectedPages = parsePageSelector(opts.pages ?? null);
	const cursor = decodePageCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const variant = opts.variant?.trim() || (await preferredVariant(db, revisionId)) || (await firstVariantWithChunks(db, revisionId));
	if (!variant) return ocrUnavailable(revisionId, pageCount);
	const rows = await listOcrPages(db, revisionId, variant);
	// Text extracted without page structure (most pdftotext variants) lands on
	// a single page-0 chunk. A per-page request would filter it out, so the
	// reader would show "no text" while whole-document text sits right there.
	// Surface it for any page, flagged as not page-aligned.
	const wholeDocument = rows.length > 0 && rows.every((row) => row.page === 0);
	if (wholeDocument) {
		if (cursor) return { revisionId, variant, pages: [], nextCursor: null, wholeDocument: true };
		return {
			revisionId,
			variant,
			wholeDocument: true,
			pages: rows.map((row) => ({ page: row.page, text: row.text })),
			nextCursor: null
		};
	}
	const selected = rows.filter((row) => row.page > (cursor?.page ?? -1) && (!selectedPages || selectedPages.includes(row.page)));
	if (selected.length === 0) return ocrUnavailable(revisionId, pageCount);
	const limit = opts.limit ?? DEFAULT_TEXT_LIMIT;
	const page = selected.slice(0, limit);
	const last = page.at(-1);
	return {
		revisionId,
		variant,
		pages: page.map((row) => ({ page: row.page, text: row.text })),
		nextCursor: selected.length > limit && last ? encodePageCursor({ page: last.page }) : null
	};
}

export async function searchOcr(
	db: Db,
	principal: ArchivePrincipal,
	opts: {
		q: string;
		cursor?: string | null;
		sourceSlug?: string | null;
		variant?: string | null;
		maxChars?: number;
		limit?: number;
		internalCap?: number;
	}
) {
	const q = opts.q.trim();
	if (!q) throw new ArchiveHttpError(400, 'q is required');
	if ([...normalizeOcrText(q)].length < 3) throw new ArchiveHttpError(400, 'phrase queries require at least three characters');
	const cursor = decodeSearchCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const alternatives = literalPhraseAlternatives(q);
	const internalCap = opts.internalCap ?? SEARCH_INTERNAL_CAP;
	if (!Number.isSafeInteger(internalCap) || internalCap <= 0 || internalCap > SEARCH_INTERNAL_CAP) {
		throw new ArchiveHttpError(400, 'invalid search cap');
	}
	const ftsQuery = alternatives.map(escapeFtsLiteral).join(' OR ');
	const visibility = archiveSearchVisibilitySql(principal);
	const sourceClause = opts.sourceSlug ? sql`and src.slug = ${opts.sourceSlug}` : sql``;
	const variantClause = opts.variant?.trim()
		? sql`and c.variant = ${opts.variant.trim()}`
		: sql`and c.variant = coalesce(
			-- A human edit supersedes machine OCR for that page, so an edited
			-- chunk wins over the preferred machine variant page by page.
			(
				select 'edited'
				from ocr_chunks edited_chunk
				inner join ocr_ingest_state edited_state
					on edited_state.revision_id = edited_chunk.revision_id
					and edited_state.variant = edited_chunk.variant
					and edited_state.active_generation = edited_chunk.ingest_generation
				where edited_chunk.revision_id = c.revision_id
					and edited_chunk.variant = 'edited'
					and edited_chunk.page = c.page
				limit 1
			),
			(
				select coverage.variant
				from revision_ocr_coverage coverage
				inner join ocr_ingest_state preferred_state
					on preferred_state.revision_id = coverage.revision_id
					and preferred_state.variant = coverage.variant
				where coverage.revision_id = c.revision_id and coverage.preferred = 1
				limit 1
			),
			(
				select min(fallback.variant)
				from ocr_ingest_state fallback
				where fallback.revision_id = c.revision_id
			)
		)`;

	let rows: RankedChunk[];
	try {
		rows = await db.all<RankedChunk>(sql`
			with matched as (
				select
					c.chunk_id as chunkId,
					c.revision_id as revisionId,
					c.variant,
					cast(c.page as integer) as page,
					cast(c.block as integer) as block,
					${snippetWindowSql(alternatives)} as text,
					'' as textNorm,
					bm25(ocr_chunks_fts) as rank,
					src.slug as sourceSlug,
					src.title as sourceTitle,
					src.title_en as sourceTitleEn,
					src.title_ain as sourceTitleAin,
					src.author as sourceAuthor,
					src.year_text as sourceYearText,
					src.year_start as sourceYearStart,
					src.year_end as sourceYearEnd,
					src.year_certainty as sourceYearCertainty
				from ocr_chunks_fts
				inner join ocr_chunks c on c.rowid = ocr_chunks_fts.rowid
				inner join ocr_ingest_state state
					on state.revision_id = c.revision_id
					and state.variant = c.variant
					and state.active_generation = c.ingest_generation
				inner join file_revisions fr on fr.id = c.revision_id
				inner join source_files sf on sf.id = fr.source_file_id
				inner join sources src on src.id = sf.source_id
				where ocr_chunks_fts match ${ftsQuery}
					and (${phraseVerificationSql(alternatives)})
					and ${visibility}
					${variantClause}
					${sourceClause}
			), deduplicated as (
				select *, row_number() over (
					partition by revisionId, page
					order by rank, block, chunkId
				) as pageRow
				from matched
			)
			select
				chunkId, revisionId, variant, page, block, text, textNorm, rank,
				sourceSlug, sourceTitle, sourceTitleEn, sourceTitleAin, sourceAuthor,
				sourceYearText, sourceYearStart, sourceYearEnd, sourceYearCertainty
			from deduplicated
			where pageRow = 1
			order by rank, chunkId
			limit ${internalCap + 1}
		`);
	} catch (error) {
		// The driver's message can carry SQL, hostnames, and connection details.
		// Log it server-side; the client gets the failure, not the internals.
		console.error('archive search index query failed', error);
		throw new ArchiveHttpError(500, 'search index query failed');
	}

	// Verification now happens in SQL, so every row returned is a match.
	const verified = rows;
	const truncated = rows.length > internalCap;
	const bounded = verified.slice(0, internalCap);
	const afterCursor = cursor
		? bounded.filter((row) => row.rank > cursor.rank || (row.rank === cursor.rank && row.chunkId > cursor.chunkId))
		: bounded;
	const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
	const page = afterCursor.slice(0, limit);
	const last = page.at(-1);
	const maxChars = opts.maxChars ?? 240;
	return {
		mode: 'phrase' as const,
		items: page.map((hit) => serializeHit(hit, q, maxChars)),
		nextCursor: afterCursor.length > limit && last ? encodeSearchCursor({ rank: last.rank, chunkId: last.chunkId }) : null,
		total: bounded.length,
		truncated,
		cap: internalCap
	};
}

// A chunk holding a whole book runs to millions of characters. Shipping that
// text to verify a match and to cut a 260-character snippet dominated every
// query, so both happen in SQL: the match is verified with instr, and only a
// window around the first occurrence is returned.
const SNIPPET_WINDOW_BEFORE = 300;
const SNIPPET_WINDOW_CHARS = 1400;

function phraseVerificationSql(alternatives: string[]) {
	const tests = alternatives.map(
		(alternative) =>
			sql`instr(c.text, ${alternative}) > 0 or instr(c.text_norm, ${normalizeOcrText(alternative)}) > 0`
	);
	return sql.join(tests, sql` or `);
}

function snippetWindowSql(alternatives: string[]) {
	const positions = alternatives.map(
		(alternative) => sql`nullif(instr(c.text, ${alternative}), 0)`
	);
	const firstMatch = sql`coalesce(${sql.join(positions, sql`, `)}, 1)`;
	return sql`substr(c.text, max(1, ${firstMatch} - ${SNIPPET_WINDOW_BEFORE}), ${SNIPPET_WINDOW_CHARS})`;
}

function phraseMatches(row: RankedChunk, alternatives: string[]): boolean {
	return alternatives.some((alternative) => row.text.includes(alternative) || row.textNorm.includes(normalizeOcrText(alternative)));
}

function serializeHit(hit: RankedChunk, query: string, maxChars: number) {
	return {
		// Page 0 means whole-document text with no page alignment; a citation
		// must say so rather than claim a page that does not exist.
		wholeDocument: hit.page === 0,
		source: {
			slug: hit.sourceSlug,
			title: hit.sourceTitle,
			titleEn: hit.sourceTitleEn,
			titleAin: hit.sourceTitleAin,
			author: hit.sourceAuthor,
			year: hit.sourceYearText ?? hit.sourceYearStart,
			yearText: hit.sourceYearText,
			yearStart: hit.sourceYearStart,
			yearEnd: hit.sourceYearEnd,
			yearCertainty: hit.sourceYearCertainty
		},
		revision: hit.revisionId,
		revisionId: hit.revisionId,
		page: hit.page,
		block: hit.block,
		variant: hit.variant,
		rank: hit.rank,
		snippet: makeSnippet(hit.text, query, maxChars)
	};
}

async function preferredVariant(db: Db, revisionId: string): Promise<string | null> {
	const [row] = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.preferred, true)))
		.limit(1);
	return row?.variant ?? null;
}

async function firstVariantWithChunks(db: RawSqlDb, revisionId: string): Promise<string | null> {
	const [row] = await db.all<{ variant: string }>(sql`
		select state.variant
		from ocr_ingest_state state
		where state.revision_id = ${revisionId}
			and exists (
				select 1 from ocr_chunks c
				where c.revision_id = state.revision_id
					and c.variant = state.variant
					and c.ingest_generation = state.active_generation
			)
		order by state.variant
		limit 1
	`);
	return row?.variant ?? null;
}

function ocrUnavailable(revisionId: string, pageCount: number | null) {
	if (Number.isSafeInteger(pageCount) && pageCount != null && pageCount > 0) {
		return {
			error: 'ocr_unavailable',
			alternatives: Array.from({ length: pageCount }, (_, index) => {
				const page = index + 1;
				return { page, path: `/api/archive/revisions/${revisionId}/pages/${page}.webp` };
			})
		};
	}
	return { error: 'ocr_unavailable', alternatives: [], note: 'page count unavailable' };
}

function splitPageBlocks(text: string): string[] {
	const blocks = text.normalize('NFC').split(/\r?\n[\t ]*\r?\n+/u);
	return blocks.length > 0 ? blocks : [''];
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function makeSnippet(text: string, query: string, maxChars: number): { text: string; offsets: { start: number; end: number }[] } {
	const width = Math.min(Math.max(maxChars, 40), 1000);
	const ranges = matchOffsets(text, query);
	const anchor = ranges[0]?.start ?? 0;
	const start = Math.max(0, Math.min(anchor - Math.floor(width / 3), Math.max(0, text.length - width)));
	const snippet = text.slice(start, start + width);
	return {
		text: snippet,
		offsets: ranges
			.filter((range) => range.end > start && range.start < start + snippet.length)
			.map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(snippet.length, range.end - start) }))
	};
}

function matchOffsets(text: string, query: string): { start: number; end: number }[] {
	const raw = allSubstringOffsets(text, query.normalize('NFC'));
	if (raw.length > 0) return raw;
	const normalizedText = normalizeOcrText(text);
	const normalizedQuery = normalizeOcrText(query);
	const normalizedRanges = allSubstringOffsets(normalizedText, normalizedQuery);
	if (normalizedRanges.length === 0) return [];
	const boundaries = [0];
	for (const char of text) boundaries.push(boundaries.at(-1)! + char.length);
	const prefixLengths = boundaries.map((boundary) => normalizeOcrText(text.slice(0, boundary)).length);
	return normalizedRanges.map((range) => ({
		start: boundaryForNormalizedOffset(boundaries, prefixLengths, range.start, false),
		end: boundaryForNormalizedOffset(boundaries, prefixLengths, range.end, true)
	}));
}

function allSubstringOffsets(text: string, query: string): { start: number; end: number }[] {
	if (!query) return [];
	const offsets: { start: number; end: number }[] = [];
	let index = text.indexOf(query);
	while (index !== -1) {
		offsets.push({ start: index, end: index + query.length });
		index = text.indexOf(query, index + Math.max(query.length, 1));
	}
	return offsets;
}

function boundaryForNormalizedOffset(boundaries: number[], prefixLengths: number[], offset: number, end: boolean): number {
	for (let index = 0; index < prefixLengths.length; index += 1) {
		if (end ? prefixLengths[index] >= offset : prefixLengths[index] > offset) {
			return boundaries[Math.max(0, end ? index : index - 1)];
		}
	}
	return boundaries.at(-1) ?? 0;
}

async function searchRegex(
	db: Db,
	principal: ArchivePrincipal,
	opts: {
		q: string;
		cursor?: string | null;
		sourceSlug?: string | null;
		variant?: string | null;
		maxChars?: number;
		limit?: number;
	}
) {
	const pattern = opts.q;
	if (!pattern) throw new ArchiveHttpError(400, 'q is required');
	let ast: ReturnType<typeof parseRegexAst>;
	try {
		ast = parseRegexAst(pattern);
	} catch (error) {
		if (error instanceof RegexSyntaxError) throw regexRequestError(error.message, pattern, error.position);
		throw error;
	}
	const literals = extractRegexLiterals(ast);
	if (literals.length === 0) {
		throw regexRequestError('regex requires a literal run of at least three characters on every branch', pattern, 0);
	}
	const matcher = compileLinearRegex(ast);
	const cursor = decodeSearchCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const rows = await loadFtsChunks(db, principal, {
		ftsQuery: literals.map(escapeFtsLiteral).join(' OR '),
		sourceSlug: opts.sourceSlug,
		variant: opts.variant,
		limit: REGEX_CANDIDATE_CAP + 1
	});
	let budgetBound = false;
	const deadline = Date.now() + REGEX_TIME_BUDGET_MS;
	const verified: Array<{ hit: RankedChunk; range: { start: number; end: number } }> = [];
	for (const hit of rows.slice(0, REGEX_CANDIDATE_CAP)) {
		try {
			const range = matcher.find(hit.text, deadline);
			if (range) verified.push({ hit, range });
		} catch (error) {
			if (error instanceof Error && error.message === 'regex time budget exceeded') {
				budgetBound = true;
				break;
			}
			throw error;
		}
	}
	const deduplicated = new Map<string, (typeof verified)[number]>();
	for (const match of verified) {
		const key = `${match.hit.revisionId}:${match.hit.page}`;
		if (!deduplicated.has(key)) deduplicated.set(key, match);
	}
	const bounded = [...deduplicated.values()];
	const afterCursor = cursor
		? bounded.filter(({ hit }) => hit.rank > cursor.rank || (hit.rank === cursor.rank && hit.chunkId > cursor.chunkId))
		: bounded;
	const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
	const page = afterCursor.slice(0, limit);
	const last = page.at(-1);
	return {
		mode: 'regex' as const,
		items: page.map(({ hit, range }) => ({
			...serializeHit(hit, pattern, opts.maxChars ?? 240),
			snippet: makeSnippetForRanges(hit.text, [range], opts.maxChars ?? 240)
		})),
		nextCursor:
			afterCursor.length > limit && last ? encodeSearchCursor({ rank: last.hit.rank, chunkId: last.hit.chunkId }) : null,
		total: bounded.length,
		truncated: rows.length > REGEX_CANDIDATE_CAP || budgetBound,
		cap: REGEX_CANDIDATE_CAP,
		timeBudgetMs: REGEX_TIME_BUDGET_MS
	};
}

async function loadFtsChunks(
	db: Db,
	principal: ArchivePrincipal,
	opts: { ftsQuery: string; sourceSlug?: string | null; variant?: string | null; limit: number }
): Promise<RankedChunk[]> {
	const visibility = archiveSearchVisibilitySql(principal);
	const sourceClause = opts.sourceSlug ? sql`and src.slug = ${opts.sourceSlug}` : sql``;
	const variantClause = searchVariantClause(opts.variant);
	return db.all<RankedChunk>(sql`
		select
			c.chunk_id as chunkId,
			c.revision_id as revisionId,
			c.variant,
			cast(c.page as integer) as page,
			cast(c.block as integer) as block,
			c.text,
			c.text_norm as textNorm,
			bm25(ocr_chunks_fts) as rank,
			src.slug as sourceSlug,
			src.title as sourceTitle,
			src.title_en as sourceTitleEn,
			src.title_ain as sourceTitleAin,
			src.author as sourceAuthor,
			src.year_text as sourceYearText,
			src.year_start as sourceYearStart,
			src.year_end as sourceYearEnd,
			src.year_certainty as sourceYearCertainty
		from ocr_chunks_fts
		inner join ocr_chunks c on c.rowid = ocr_chunks_fts.rowid
		inner join ocr_ingest_state state
			on state.revision_id = c.revision_id
			and state.variant = c.variant
			and state.active_generation = c.ingest_generation
		inner join file_revisions fr on fr.id = c.revision_id
		inner join source_files sf on sf.id = fr.source_file_id
		inner join sources src on src.id = sf.source_id
		where ocr_chunks_fts match ${opts.ftsQuery}
			and ${visibility}
			${variantClause}
			${sourceClause}
		order by bm25(ocr_chunks_fts), c.chunk_id
		limit ${opts.limit}
	`);
}

function regexRequestError(message: string, pattern: string, position: number): ArchiveHttpError {
	const safePosition = Math.max(0, Math.min(position, pattern.length));
	return new ArchiveHttpError(400, message, {
		position: safePosition,
		marker: `${pattern}\n${' '.repeat(safePosition)}^`
	});
}

function searchVariantClause(variant?: string | null) {
	return variant?.trim()
		? sql`and c.variant = ${variant.trim()}`
		: sql`and c.variant = coalesce(
			(
				select coverage.variant
				from revision_ocr_coverage coverage
				inner join ocr_ingest_state preferred_state
					on preferred_state.revision_id = coverage.revision_id
					and preferred_state.variant = coverage.variant
				where coverage.revision_id = c.revision_id and coverage.preferred = 1
				limit 1
			),
			(select min(fallback.variant) from ocr_ingest_state fallback where fallback.revision_id = c.revision_id)
		)`;
}

function makeSnippetForRanges(
	text: string,
	ranges: { start: number; end: number }[],
	maxChars: number
): { text: string; offsets: { start: number; end: number }[] } {
	const width = Math.min(Math.max(maxChars, 40), 1000);
	const anchor = ranges[0]?.start ?? 0;
	const start = Math.max(0, Math.min(anchor - Math.floor(width / 3), Math.max(0, text.length - width)));
	const snippet = text.slice(start, start + width);
	return {
		text: snippet,
		offsets: ranges
			.filter((range) => range.end > start && range.start < start + snippet.length)
			.map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(snippet.length, range.end - start) }))
	};
}

type SoftOccurrence = RankedChunk & { tokenNorm: string };
type SoftAlignment = { query_token: string; matched_token: string; score: number };

async function searchSoft(
	db: Db,
	principal: ArchivePrincipal,
	opts: {
		q: string;
		tolerance?: SearchTolerance;
		cursor?: string | null;
		sourceSlug?: string | null;
		variant?: string | null;
		maxChars?: number;
		limit?: number;
	}
) {
	const queryTokens = tokenizeNormalizedText(opts.q);
	if (queryTokens.length === 0) throw new ArchiveHttpError(400, 'q must contain at least one searchable token');
	if (queryTokens.length > 12) throw new ArchiveHttpError(400, 'soft search accepts at most 12 query tokens');
	const tolerance = opts.tolerance ?? 'normal';
	const maxDistance = { strict: 0, normal: 1, loose: 2 }[tolerance];
	const cursor = decodeSearchCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const alternativeLengths = queryTokens.flatMap(({ token }) =>
		expandNormalizedTokenAlternatives(token).map((alternative) => [...alternative].length)
	);
	const minLength = Math.max(1, Math.min(...alternativeLengths) - maxDistance);
	const maxLength = Math.max(...alternativeLengths) + maxDistance;
	const visibility = archiveSearchVisibilitySql(principal);
	const variantClause = searchVariantClause(opts.variant);
	const sourceClause = opts.sourceSlug ? sql`and src.slug = ${opts.sourceSlug}` : sql``;
	// Candidates must be narrowed in SQL, not sampled: ordering the whole
	// vocabulary alphabetically and taking the first N silently drops every
	// token that sorts later, so a query like "language" would never match.
	// Exact forms are always included; fuzzy candidates share a first
	// character with one of the query's alternatives, which covers the
	// orthographic variation this mode exists for.
	// Soft matching reads the chunk text directly rather than a per-token
	// index. The corpus is small enough that candidate chunks can be narrowed
	// in SQL and tokenized in memory, which keeps the mode working everywhere
	// the text is indexed instead of waiting on a multi-million-row token
	// table that this database cannot absorb without starving live reads.
	// Kana expands to several romanizations; keeping every one multiplies the
	// probe set and the candidate scan, so the list is bounded.
	const queryAlternatives = [...new Set(queryTokens.flatMap(({ token }) => expandNormalizedTokenAlternatives(token)))].slice(0, 6);
	// A distance-1 edit still shares one of the token's deletion variants, so
	// substring probes on those variants retrieve fuzzy candidates cheaply.
	const exactProbes = queryAlternatives.filter((alternative) => [...alternative].length >= 3);
	// Deletion variants retrieve near-misses, but for a common word their
	// posting lists are enormous. They are only consulted when the exact forms
	// return little, which is exactly the misspelling case they exist for.
	const fuzzyProbes = [...new Set(queryAlternatives.flatMap((alternative) => {
		const characters = [...alternative];
		const deletions = characters.map((_, index) => characters.filter((_, i) => i !== index).join(''));
		// A substitution in the middle leaves the ends intact, so the head and
		// tail of the token retrieve candidates that deletion variants miss.
		const head = characters.slice(0, 4).join('');
		const tail = characters.slice(-4).join('');
		return [...deletions, head, tail];
	}))].filter((probe) => [...probe].length >= 3).slice(0, 14);
	if (exactProbes.length === 0 && fuzzyProbes.length === 0) {
		return emptySearchResult('soft', SOFT_OCCURRENCE_CAP, false, { tolerance, maxDistance });
	}

	const retrieve = async (probeList: string[]): Promise<SoftOccurrence[]> => {
		if (probeList.length === 0) return [];
		const probeQuery = probeList.map(escapeFtsLiteral).join(' OR ');
		return db.all<SoftOccurrence>(sql`
		select
			c.chunk_id as chunkId,
			c.revision_id as revisionId,
			c.variant,
			c.page,
			c.block,
			substr(c.text, 1, ${SOFT_CHUNK_CHAR_CAP}) as text,
			'' as textNorm,
			0 as rank,
			'' as tokenNorm,
			src.slug as sourceSlug,
			src.title as sourceTitle,
			src.title_en as sourceTitleEn,
			src.title_ain as sourceTitleAin,
			src.author as sourceAuthor,
			src.year_text as sourceYearText,
			src.year_start as sourceYearStart,
			src.year_end as sourceYearEnd,
			src.year_certainty as sourceYearCertainty
		from ocr_chunks_fts
		inner join ocr_chunks c on c.rowid = ocr_chunks_fts.rowid
		inner join ocr_ingest_state state
			on state.revision_id = c.revision_id
			and state.variant = c.variant
			and state.active_generation = c.ingest_generation
		inner join file_revisions fr on fr.id = c.revision_id
		inner join source_files sf on sf.id = fr.source_file_id
		inner join sources src on src.id = sf.source_id
		where ocr_chunks_fts match ${probeQuery}
			and ${visibility}
			${variantClause}
			${sourceClause}
		order by bm25(ocr_chunks_fts)
		limit ${SOFT_CHUNK_SCAN_CAP + 1}
	`);
	};
	const exactRows = await retrieve(exactProbes);
	const occurrences = [...exactRows];
	if (exactRows.length < SOFT_CHUNK_SCAN_CAP) {
		const seen = new Set(exactRows.map((row) => row.chunkId));
		for (const row of await retrieve(fuzzyProbes)) {
			if (seen.has(row.chunkId)) continue;
			seen.add(row.chunkId);
			occurrences.push(row);
			if (occurrences.length > SOFT_CHUNK_SCAN_CAP) break;
		}
	}
	const alignmentsByChunk = new Map<string, Map<string, SoftAlignment>>();
	let scannedCharacters = 0;
	let scanTruncated = false;
	for (const occurrence of occurrences.slice(0, SOFT_CHUNK_SCAN_CAP)) {
		if (scannedCharacters >= SOFT_TOTAL_CHAR_CAP) {
			scanTruncated = true;
			break;
		}
		const scanned = occurrence.text.slice(0, SOFT_CHUNK_CHAR_CAP);
		if (scanned.length < occurrence.text.length) scanTruncated = true;
		scannedCharacters += scanned.length;
		const best = new Map<string, SoftAlignment>();
		const chunkTokens = new Set(tokenizeNormalizedText(scanned).map(({ token }) => token));
		for (const query of queryTokens) {
			const alternatives = expandNormalizedTokenAlternatives(query.token);
			const lengths = alternatives.map((alternative) => [...alternative].length);
			const shortest = Math.min(...lengths) - maxDistance;
			const longest = Math.max(...lengths) + maxDistance;
			for (const candidate of chunkTokens) {
				// Length is a cheap necessary condition for an edit distance
				// within tolerance; checking it first avoids the expensive
				// comparison for most of the page's vocabulary.
				const candidateLength = candidate.length;
				if (candidateLength < shortest || candidateLength > longest) continue;
				const distance = Math.min(
					...alternatives.map((alternative) => damerauLevenshtein(alternative, candidate, maxDistance))
				);
				if (distance > maxDistance) continue;
				const score = 1 - distance / Math.max([...query.token].length, [...candidate].length, 1);
				const previous = best.get(query.token);
				if (!previous || previous.score < score) {
					best.set(query.token, { query_token: query.token, matched_token: candidate, score });
				}
				if (distance === 0) break;
			}
		}
		if (best.size > 0) alignmentsByChunk.set(occurrence.chunkId, best);
	}

	const chunks = new Map<string, { hit: RankedChunk; alignments: Map<string, SoftAlignment> }>();
	for (const occurrence of occurrences.slice(0, SOFT_OCCURRENCE_CAP)) {
		const alignments = alignmentsByChunk.get(occurrence.chunkId);
		if (!alignments) continue;
		chunks.set(occurrence.chunkId, { hit: occurrence, alignments });
	}
	const ranked = [...chunks.values()]
		.filter((group) => group.alignments.size === queryTokens.length)
		.map((group) => {
			const alignments = [...group.alignments.values()];
			const score = alignments.reduce((sum, alignment) => sum + alignment.score, 0) / alignments.length;
			return { ...group, score, hit: { ...group.hit, rank: 1 - score } };
		})
		.sort((left, right) => left.hit.rank - right.hit.rank || left.hit.chunkId.localeCompare(right.hit.chunkId));
	const deduplicated = new Map<string, (typeof ranked)[number]>();
	for (const candidate of ranked) {
		const key = `${candidate.hit.revisionId}:${candidate.hit.page}`;
		if (!deduplicated.has(key)) deduplicated.set(key, candidate);
	}
	const bounded = [...deduplicated.values()];
	const afterCursor = cursor
		? bounded.filter(({ hit }) => hit.rank > cursor.rank || (hit.rank === cursor.rank && hit.chunkId > cursor.chunkId))
		: bounded;
	const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
	const page = afterCursor.slice(0, limit);
	const last = page.at(-1);
	const maxChars = opts.maxChars ?? 240;
	return {
		mode: 'soft' as const,
		tolerance,
		maxDistance,
		items: page.map(({ hit, alignments, score }) => ({
			...serializeHit(hit, opts.q, maxChars),
			score,
			alignments: [...alignments.values()],
			snippet: makeSnippetForRanges(
				hit.text,
				[...alignments.values()].flatMap((alignment) => matchOffsets(hit.text, alignment.matched_token)),
				maxChars
			)
		})),
		nextCursor:
			afterCursor.length > limit && last ? encodeSearchCursor({ rank: last.hit.rank, chunkId: last.hit.chunkId }) : null,
		total: bounded.length,
		truncated: occurrences.length > SOFT_CHUNK_SCAN_CAP || scanTruncated,
		cap: SOFT_OCCURRENCE_CAP
	};
}

export function damerauLevenshtein(left: string, right: string, bound = Number.POSITIVE_INFINITY): number {
	const a = [...left];
	const b = [...right];
	if (Math.abs(a.length - b.length) > bound) return bound + 1;
	let previousPrevious = new Array<number>(b.length + 1).fill(0);
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let row = 1; row <= a.length; row += 1) {
		const current = new Array<number>(b.length + 1).fill(0);
		current[0] = row;
		let rowMinimum = current[0];
		for (let column = 1; column <= b.length; column += 1) {
			const substitution = previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1);
			current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, substitution);
			if (
				row > 1 &&
				column > 1 &&
				a[row - 1] === b[column - 2] &&
				a[row - 2] === b[column - 1]
			) {
				current[column] = Math.min(current[column], previousPrevious[column - 2] + 1);
			}
			rowMinimum = Math.min(rowMinimum, current[column]);
		}
		if (rowMinimum > bound) return bound + 1;
		previousPrevious = previous;
		previous = current;
	}
	return previous[b.length];
}

function emptySearchResult(mode: 'soft' | 'similar', cap: number, truncated: boolean, extra: Record<string, unknown> = {}) {
	return { mode, items: [], nextCursor: null, total: 0, truncated, cap, ...extra };
}

type SimilarCandidate = RankedChunk & { sharedTokenCount: number };

async function searchSimilar(
	db: Db,
	principal: ArchivePrincipal,
	opts: {
		q: string;
		cursor?: string | null;
		sourceSlug?: string | null;
		variant?: string | null;
		maxChars?: number;
		limit?: number;
	}
) {
	const reference = /^(.*):(\d+)$/u.exec(opts.q);
	if (!reference || !reference[1]) {
		throw new ArchiveHttpError(400, 'similar search q must be revision:page');
	}
	const revisionId = reference[1];
	const pageNumber = Number(reference[2]);
	if (!Number.isSafeInteger(pageNumber)) throw new ArchiveHttpError(400, 'similar search page is invalid');
	const cursor = decodeSearchCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const visibility = archiveSearchVisibilitySql(principal);
	const variantClause = searchVariantClause(opts.variant);
	// The token index is not populated; tokenizing the chunk text in memory
	// keeps this mode working on the same data every other mode reads.
	const referenceChunks = await db.all<{ text: string }>(sql`
		select c.text as text
		from ocr_chunks c
		inner join ocr_ingest_state state
			on state.revision_id = c.revision_id
			and state.variant = c.variant
			and state.active_generation = c.ingest_generation
		inner join file_revisions fr on fr.id = c.revision_id
		inner join source_files sf on sf.id = fr.source_file_id
		inner join sources src on src.id = sf.source_id
		where c.revision_id = ${revisionId}
			and cast(c.page as integer) = ${pageNumber}
			and ${visibility}
			${variantClause}
		order by c.block
	`);
	if (referenceChunks.length === 0) throw new ArchiveHttpError(404, 'reference page text is unavailable');
	// A page-0 reference is whole-document text (extraction without page
	// structure). "Passages similar to this entire book" is not a meaningful
	// query, and answering it means comparing against the whole corpus, so it
	// is refused plainly. Per-page text makes the mode work for these works.
	if (pageNumber === 0) {
		throw new ArchiveHttpError(
			422,
			'similar search needs page-level text; this work has whole-document text only'
		);
	}
	// Truncate the text before tokenizing: a whole-document reference can be an
	// entire book, and tokenizing it in full is the expensive part.
	const referenceSequence = referenceChunks
		.flatMap((chunk) => tokenizeNormalizedText(chunk.text.slice(0, SIMILAR_REFERENCE_CHAR_CAP)).map((t) => t.token))
		.slice(0, SIMILAR_REFERENCE_TOKEN_CAP);
	if (referenceSequence.length === 0) throw new ArchiveHttpError(404, 'reference page text is unavailable');
	const referenceNgrams = tokenNgrams(referenceSequence);
	const uniqueReferenceTokens = [...new Set(referenceSequence)];
	const referenceTokenBound = 400;
	const boundReferenceTokens = uniqueReferenceTokens.slice(0, referenceTokenBound);
	const sourceClause = opts.sourceSlug ? sql`and src.slug = ${opts.sourceSlug}` : sql``;
	// Common short tokens have enormous posting lists; longer ones are rarer
	// and retrieve a far smaller candidate set for the same recall.
	const probeTokens = [...new Set(referenceSequence)]
		.filter((token) => [...token].length >= 4)
		.sort((a, b) => [...b].length - [...a].length)
		.slice(0, 6);
	if (probeTokens.length === 0) {
		return emptySearchResult('similar', SIMILAR_CANDIDATE_CAP, false, {
			reference: { revision: revisionId, page: pageNumber }
		});
	}
	const probeQuery = probeTokens.map(escapeFtsLiteral).join(' OR ');
	const candidates = await db.all<SimilarCandidate>(sql`
		select
			c.chunk_id as chunkId,
			c.revision_id as revisionId,
			c.variant,
			cast(c.page as integer) as page,
			c.block,
			c.text,
			c.text_norm as textNorm,
			0 as rank,
			0 as sharedTokenCount,
			src.slug as sourceSlug,
			src.title as sourceTitle,
			src.title_en as sourceTitleEn,
			src.title_ain as sourceTitleAin,
			src.author as sourceAuthor,
			src.year_text as sourceYearText,
			src.year_start as sourceYearStart,
			src.year_end as sourceYearEnd,
			src.year_certainty as sourceYearCertainty
		from ocr_chunks_fts
		inner join ocr_chunks c on c.rowid = ocr_chunks_fts.rowid
		inner join ocr_ingest_state state
			on state.revision_id = c.revision_id
			and state.variant = c.variant
			and state.active_generation = c.ingest_generation
		inner join file_revisions fr on fr.id = c.revision_id
		inner join source_files sf on sf.id = fr.source_file_id
		inner join sources src on src.id = sf.source_id
		where ocr_chunks_fts match ${probeQuery}
			and not (c.revision_id = ${revisionId} and cast(c.page as integer) = ${pageNumber})
			and ${visibility}
			${variantClause}
			${sourceClause}
		order by bm25(ocr_chunks_fts)
		limit ${SIMILAR_CANDIDATE_CAP + 1}
	`);
	const boundedCandidates = candidates.slice(0, SIMILAR_CANDIDATE_CAP);
	if (boundedCandidates.length === 0) {
		return emptySearchResult('similar', SIMILAR_CANDIDATE_CAP, candidates.length > SIMILAR_CANDIDATE_CAP, {
			reference: { revision: revisionId, page: pageNumber }
		});
	}
	const candidateByChunk = new Map(boundedCandidates.map((candidate) => [candidate.chunkId, candidate]));
	const sequences = new Map<string, string[]>();
	for (const candidate of boundedCandidates) {
		sequences.set(
			candidate.chunkId,
			tokenizeNormalizedText(candidate.text.slice(0, SIMILAR_REFERENCE_CHAR_CAP))
				.map((t) => t.token)
				.slice(0, SIMILAR_REFERENCE_TOKEN_CAP)
		);
	}
	const ranked = [...sequences.entries()]
		.map(([chunkId, sequence]) => {
			const hit = candidateByChunk.get(chunkId)!;
			const grams = tokenNgrams(sequence);
			const shared = [...grams].filter((gram) => referenceNgrams.has(gram));
			const union = new Set([...referenceNgrams, ...grams]).size;
			const score = union === 0 ? 0 : shared.length / union;
			const sharedTokens = [...new Set(sequence.filter((token) => uniqueReferenceTokens.includes(token)))];
			return { hit: { ...hit, rank: -score }, score, shared, sharedTokens };
		})
		.filter((candidate) => candidate.shared.length > 0)
		.sort((left, right) => left.hit.rank - right.hit.rank || left.hit.chunkId.localeCompare(right.hit.chunkId));
	const deduplicated = new Map<string, (typeof ranked)[number]>();
	for (const candidate of ranked) {
		const key = `${candidate.hit.revisionId}:${candidate.hit.page}`;
		if (!deduplicated.has(key)) deduplicated.set(key, candidate);
	}
	const bounded = [...deduplicated.values()];
	const afterCursor = cursor
		? bounded.filter(({ hit }) => hit.rank > cursor.rank || (hit.rank === cursor.rank && hit.chunkId > cursor.chunkId))
		: bounded;
	const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
	const page = afterCursor.slice(0, limit);
	const last = page.at(-1);
	const maxChars = opts.maxChars ?? 240;
	return {
		mode: 'similar' as const,
		reference: { revision: revisionId, page: pageNumber },
		items: page.map(({ hit, score, shared, sharedTokens }) => ({
			...serializeHit(hit, sharedTokens.join(' '), maxChars),
			score,
			sharedNgrams: shared,
			snippet: makeSnippetForRanges(
				hit.text,
				sharedTokens.flatMap((token) => matchOffsets(hit.text, token)),
				maxChars
			)
		})),
		nextCursor:
			afterCursor.length > limit && last ? encodeSearchCursor({ rank: last.hit.rank, chunkId: last.hit.chunkId }) : null,
		total: bounded.length,
		truncated:
			uniqueReferenceTokens.length > referenceTokenBound || candidates.length > SIMILAR_CANDIDATE_CAP,
		cap: SIMILAR_CANDIDATE_CAP
	};
}

function tokenNgrams(tokens: string[]): Set<string> {
	if (tokens.length === 0) return new Set();
	const width = Math.min(3, tokens.length);
	const grams = new Set<string>();
	for (let index = 0; index <= tokens.length - width; index += 1) {
		grams.add(tokens.slice(index, index + width).join('\u001f'));
	}
	return grams;
}

function semanticUnavailable() {
	return {
		mode: 'semantic' as const,
		enabled: false,
		code: 'search_mode_not_enabled',
		message: 'Semantic search is not enabled for this corpus.',
		items: [],
		nextCursor: null,
		total: 0,
		truncated: false,
		cap: 0
	};
}

export const ocrIngestTables = { ocrIngestState, revisionOcrCoverage };
