import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { fileRevisions, sourceFiles } from '$lib/server/db/schema';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { searchOcr } from '$lib/server/archive/ocr';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: PageServerLoad = async ({ request, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (!principal) return { accessDenied: true, q, sourceSlug: url.searchParams.get('source_slug') ?? '', result: null, searchableCount: null };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const sourceSlug = url.searchParams.get('source_slug')?.trim() || null;
	const result = q
		? await searchOcr(db, principal, {
				q,
				cursor: url.searchParams.get('cursor'),
				sourceSlug,
				maxChars: 260
			})
		: { items: [], nextCursor: null, total: 0 };
	const fileByRevision = await fileIdsForRevisions(result.items.map((item) => item.revisionId));
	const searchableCount = await approvedCurrentFileCount();
	return {
		accessDenied: false,
		q,
		sourceSlug: sourceSlug ?? '',
		result: {
			...result,
			items: result.items.map((item) => ({
				...item,
				fileId: fileByRevision.get(item.revisionId) ?? null
			}))
		},
		searchableCount
	};
};

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
