import { and, eq, inArray, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import {
	fileRevisions,
	ocrIngestState,
	revisionOcrCoverage,
	sourceFiles,
	sources
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { ArchiveHttpError } from './errors';
import {
	decodePageCursor,
	decodeSearchCursor,
	encodePageCursor,
	encodeSearchCursor,
	type SearchCursor
} from './cursor';
import { archiveRoleAtLeast, type ArchivePrincipal } from './types';

type Db = LibSQLDatabase<typeof schema>;
type RawSqlDb = Pick<Db, 'run' | 'all'>;

export type OcrPageInput = { page: number; text: string };
export type OcrPageRow = { revisionId: string; variant: string; page: number; text: string };

const DEFAULT_TEXT_LIMIT = 50;
const DEFAULT_SEARCH_LIMIT = 50;
const SEARCH_INTERNAL_LIMIT = 1000;

/**
 * Parses comma-separated page numbers and closed ranges, for example `0,2-4,9`.
 * Whitespace and reversed ranges are rejected so malformed selectors do not
 * silently broaden the result set.
 */
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

export async function replaceOcrPages(db: RawSqlDb, revisionId: string, variant: string, pages: OcrPageInput[]): Promise<void> {
	// FTS5 virtual tables are outside Drizzle's table builder, so all ocr_pages
	// writes stay behind this wrapper and use tagged raw SQL.
	await db.run(sql`delete from ocr_pages where revision_id = ${revisionId} and variant = ${variant}`);
	for (const page of pages) {
		await db.run(
			sql`insert into ocr_pages (revision_id, variant, page, text) values (${revisionId}, ${variant}, ${page.page}, ${page.text})`
		);
	}
}

export async function listOcrPages(db: RawSqlDb, revisionId: string, variant: string): Promise<OcrPageRow[]> {
	return db.all<OcrPageRow>(sql`
		select revision_id as revisionId, variant, cast(page as integer) as page, text
		from ocr_pages
		where revision_id = ${revisionId} and variant = ${variant}
		order by cast(page as integer)
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
	const variant = opts.variant?.trim() || (await preferredVariant(db, revisionId)) || (await firstVariantWithPages(db, revisionId));
	if (!variant) return ocrUnavailable(revisionId, pageCount);

	const limit = opts.limit ?? DEFAULT_TEXT_LIMIT;
	const cursorPage = cursor?.page ?? -1;
	const pageClause = selectedPages
		? sql`and cast(page as integer) in (${sql.join(
				selectedPages.map((page) => sql`${page}`),
				sql`, `
			)})`
		: sql``;

	// FTS5 virtual tables are queried through tagged raw SQL in this module.
	const rows = await db.all<OcrPageRow>(sql`
		select revision_id as revisionId, variant, cast(page as integer) as page, text
		from ocr_pages
		where revision_id = ${revisionId}
			and variant = ${variant}
			and cast(page as integer) > ${cursorPage}
			${pageClause}
		order by cast(page as integer)
		limit ${limit + 1}
	`);
	if (rows.length === 0) return ocrUnavailable(revisionId, pageCount);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		revisionId,
		variant,
		pages: page.map((row) => ({ page: row.page, text: row.text })),
		nextCursor: rows.length > limit && last ? encodePageCursor({ page: last.page }) : null
	};
}

export async function searchOcr(
	db: Db,
	principal: ArchivePrincipal,
	opts: { q: string; cursor?: string | null; sourceSlug?: string | null; maxChars?: number; limit?: number }
) {
	const q = opts.q.trim();
	if (!q) throw new ArchiveHttpError(400, 'q is required');
	const cursor = decodeSearchCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');

	let hits: OcrPageRow[];
	try {
		// FTS5 MATCH is the narrow raw-SQL exception for archive OCR search.
		hits = await db.all<OcrPageRow>(sql`
			select revision_id as revisionId, variant, cast(page as integer) as page, text
			from ocr_pages
			where ocr_pages match ${q}
			limit ${SEARCH_INTERNAL_LIMIT}
		`);
	} catch {
		throw new ArchiveHttpError(400, 'invalid search query');
	}

	const revisionIds = [...new Set(hits.map((hit) => hit.revisionId))];
	if (revisionIds.length === 0) return { items: [], nextCursor: null, total: 0 };
	const sourceClause = opts.sourceSlug ? eq(sources.slug, opts.sourceSlug) : undefined;
	const metaRows = await db
		.select({
			revisionId: fileRevisions.id,
			reviewStatus: fileRevisions.reviewStatus,
			accessState: fileRevisions.accessState,
			isCurrent: fileRevisions.isCurrent,
			submittedBy: fileRevisions.submittedBy,
			sourceSlug: sources.slug,
			sourceTitle: sources.title,
			humanDownload: sources.humanDownload
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.where(and(inArray(fileRevisions.id, revisionIds), sourceClause));

	const metaByRevision = new Map(metaRows.map((row) => [row.revisionId, row]));
	const visible = hits
		.map((hit) => ({ hit, meta: metaByRevision.get(hit.revisionId) }))
		.filter((entry): entry is { hit: OcrPageRow; meta: NonNullable<(typeof entry)['meta']> } => {
			return !!entry.meta && canReadRevisionText(principal, entry.meta);
		})
		.sort((a, b) => compareSearchKey(a.hit, b.hit));

	const afterCursor = cursor ? visible.filter((entry) => compareSearchKey(entry.hit, cursor) > 0) : visible;
	const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
	const page = afterCursor.slice(0, limit);
	const last = page.at(-1);
	const maxChars = opts.maxChars ?? 240;

	return {
		items: page.map(({ hit, meta }) => ({
			source: { slug: meta.sourceSlug, title: meta.sourceTitle },
			revisionId: hit.revisionId,
			page: hit.page,
			variant: hit.variant,
			// Offsets are measured against this normalized snippet text.
			snippet: makeSnippet(hit.text, q, maxChars)
		})),
		nextCursor:
			afterCursor.length > limit && last
				? encodeSearchCursor({ revisionId: last.hit.revisionId, variant: last.hit.variant, page: last.hit.page })
				: null,
		// Accurate within SEARCH_INTERNAL_LIMIT; cap hits should be narrowed.
		total: visible.length
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

async function firstVariantWithPages(db: RawSqlDb, revisionId: string): Promise<string | null> {
	const [row] = await db.all<{ variant: string }>(sql`
		select variant
		from ocr_pages
		where revision_id = ${revisionId}
		group by variant
		order by variant
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

function canReadRevisionText(
	principal: ArchivePrincipal,
	row: {
		reviewStatus: string;
		accessState: string;
		isCurrent: boolean;
		submittedBy: string;
		humanDownload: boolean;
	}
): boolean {
	if (row.reviewStatus !== 'approved') {
		const ownPending =
			principal.role === 'archive_contributor' && row.submittedBy === principal.userId && row.reviewStatus === 'pending';
		if (!ownPending && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) return false;
	}
	if (!archiveRoleAtLeast(principal.role, 'archive_reviewer') && !row.isCurrent) return false;
	if (row.accessState === 'embargoed' && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) return false;
	if (row.accessState === 'takedown' && principal.role !== 'archive_admin') return false;
	if (!row.humanDownload && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) return false;
	return true;
}

function compareSearchKey(left: SearchCursor, right: SearchCursor): number {
	return left.revisionId.localeCompare(right.revisionId) || left.variant.localeCompare(right.variant) || left.page - right.page;
}

function makeSnippet(text: string, q: string, maxChars: number): { text: string; offsets: { start: number; end: number }[] } {
	const width = Math.min(Math.max(maxChars, 40), 1000);
	const needle = firstSnippetNeedle(q);
	const lowerText = text.toLocaleLowerCase();
	const index = needle ? lowerText.indexOf(needle.toLocaleLowerCase()) : -1;
	const start = index === -1 ? 0 : Math.max(0, index - Math.floor(width / 3));
	const snippet = text.slice(start, start + width).replace(/\s+/gu, ' ').trim();
	return { text: snippet, offsets: snippetOffsets(snippet, q) };
}

function firstSnippetNeedle(q: string): string | null {
	return snippetTokens(q)[0] ?? null;
}

function snippetTokens(q: string): string[] {
	const tokens: string[] = [];
	for (const token of q.split(/\s+/u)) {
		const clean = token.replace(/^["'([{]+|["')\]}]+$/gu, '');
		if (clean && !/^(and|or|not)$/iu.test(clean)) tokens.push(clean);
	}
	return tokens;
}

function snippetOffsets(text: string, q: string): { start: number; end: number }[] {
	const lowerText = text.toLocaleLowerCase();
	const ranges = snippetTokens(q).flatMap((token) => {
		const lowerToken = token.toLocaleLowerCase();
		const hits: { start: number; end: number }[] = [];
		let index = lowerText.indexOf(lowerToken);
		while (index !== -1) {
			hits.push({ start: index, end: index + token.length });
			index = lowerText.indexOf(lowerToken, index + 1);
		}
		return hits;
	});
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: { start: number; end: number }[] = [];
	for (const range of ranges) {
		const last = merged.at(-1);
		if (!last || range.start > last.end) {
			merged.push({ ...range });
			continue;
		}
		last.end = Math.max(last.end, range.end);
	}
	return merged;
}

export const ocrIngestTables = { ocrIngestState, revisionOcrCoverage };
