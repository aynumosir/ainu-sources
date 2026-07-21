import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { fileRevisions, sourceFiles } from '$lib/server/db/schema';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { searchArchive } from '$lib/server/archive/ocr';
import { listArchiveFiles } from '$lib/server/archive/db';
import { revisionPageFolios } from '$lib/server/db/schema';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { DEPLOYED_SEARCH_MODES, type SearchMode } from '$lib/server/archive/search-modes';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: PageServerLoad = async ({ request, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	const q = url.searchParams.get('q')?.trim() ?? '';
	const mode = parseMode(url.searchParams.get('mode'));
	if (!principal)
		return {
			accessDenied: true,
			q,
			mode,
			searchError: null,
			sourceSlug: url.searchParams.get('source_slug') ?? '',
			result: null,
			works: [],
			searchableCount: null
		};
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const sourceSlug = url.searchParams.get('source_slug')?.trim() || null;
	// A malformed query for a given mode is the user's mistake to correct, so it
	// is reported in the form rather than replacing the page with an error.
	let result: Awaited<ReturnType<typeof searchArchive>> = { items: [], nextCursor: null, total: 0 };
	let searchError: string | null = null;
	if (q) {
		try {
			result = await searchArchive(db, principal, {
				q,
				mode,
				cursor: url.searchParams.get('cursor'),
				sourceSlug,
				maxChars: 260
			});
		} catch (err) {
			if (err instanceof ArchiveHttpError && err.status >= 400 && err.status < 500) {
				searchError = err.message;
			} else {
				throw err;
			}
		}
	}
	const fileByRevision = await fileIdsForRevisions(result.items.map((item) => item.revisionId));
	const folioByHit = await foliosForHits(result.items.map((item) => ({ revisionId: item.revisionId, page: item.page })));
	const searchableCount = await approvedCurrentFileCount();
	// OCR search only covers works that carry recognised text, so metadata-only
	// works (a title/author/summary but no OCR pages) are otherwise invisible in
	// the archive. Match the same query against catalogue metadata so a search
	// for e.g. an author name always surfaces the work itself.
	const works = q && !sourceSlug ? await searchArchiveWorks(principal, q) : [];
	return {
		accessDenied: false,
		q,
		mode,
		searchError,
		sourceSlug: sourceSlug ?? '',
		result: {
			...result,
			items: result.items.map((item) => ({
				...item,
				fileId: fileByRevision.get(item.revisionId) ?? null,
				printedPage: folioByHit.get(`${item.revisionId}:${item.page}`) ?? null
			}))
		},
		works,
		searchableCount
	};
};

/**
 * Catalogue-metadata matches for the same query, so metadata-only works remain
 * findable even when they have no OCR text. Collapses multiple files of one work
 * to a single entry, keeping the first file id for a reader link.
 */
async function searchArchiveWorks(
	principal: NonNullable<Awaited<ReturnType<typeof resolveArchivePrincipal>>>,
	q: string
) {
	const { items } = await listArchiveFiles(db, { text: q, sort: 'title', limit: 50, principal });
	const seen = new Set<string>();
	const works: Array<{ slug: string; fileId: string; source: (typeof items)[number]['source'] }> = [];
	for (const item of items) {
		if (seen.has(item.source.slug)) continue;
		seen.add(item.source.slug);
		works.push({ slug: item.source.slug, fileId: item.file.fileId, source: item.source });
	}
	return works;
}

/**
 * The number the page prints on itself, for the hits on this results page. A
 * result should name the page a reader would cite, not its position in a scan.
 */
async function foliosForHits(hits: { revisionId: string; page: number }[]) {
	const revisionIds = [...new Set(hits.map((hit) => hit.revisionId))];
	if (revisionIds.length === 0) return new Map<string, string>();
	const rows = await db
		.select({
			revisionId: revisionPageFolios.revisionId,
			page: revisionPageFolios.page,
			label: revisionPageFolios.label
		})
		.from(revisionPageFolios)
		.where(inArray(revisionPageFolios.revisionId, revisionIds));
	return new Map(rows.map((row) => [`${row.revisionId}:${row.page}`, row.label]));
}

async function fileIdsForRevisions(revisionIds: string[]) {
	if (revisionIds.length === 0) return new Map<string, string>();
	const rows = await db
		.select({
			revisionId: fileRevisions.id,
			fileId: sourceFiles.id
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.where(inArray(fileRevisions.id, revisionIds));
	return new Map(rows.map((row) => [row.revisionId, row.fileId]));
}

async function approvedCurrentFileCount() {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.where(and(eq(fileRevisions.reviewStatus, 'approved'), eq(fileRevisions.isCurrent, true)));
	return Number(row?.count ?? 0);
}

function parseMode(value: string | null): SearchMode {
	const mode = value?.trim();
	return (DEPLOYED_SEARCH_MODES as readonly string[]).includes(mode ?? '')
		? (mode as SearchMode)
		: 'phrase';
}
