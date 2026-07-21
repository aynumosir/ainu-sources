import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { archiveBlobs, fileRevisions, persons, sourceFiles, sourcePersons, sources } from '$lib/server/db/schema';
import { getRevision, listSourceFiles } from '$lib/server/archive/db';
import { archiveRoleAtLeast, type ArchivePrincipal } from '$lib/server/archive/types';
import { getSourceDetail } from '$lib/server/queries';

export type ArchiveWorkPerson = {
	name: string;
	slug: string;
	role: string;
};

export async function loadArchiveWorkPersons(slug: string): Promise<ArchiveWorkPerson[]> {
	return db
		.select({
			name: persons.name,
			slug: persons.slug,
			role: sourcePersons.role
		})
		.from(sourcePersons)
		.innerJoin(persons, eq(sourcePersons.personId, persons.id))
		.innerJoin(sources, eq(sourcePersons.sourceId, sources.id))
		.where(eq(sources.slug, slug))
		.orderBy(asc(sourcePersons.sortOrder));
}

export async function loadArchiveWork(slug: string, principal: ArchivePrincipal, requestedPage: number | null) {
	const detail = await getSourceDetail(slug);
	if (!detail) return null;

	const rows = await listSourceFiles(db, slug, principal, {
		includeHistory: true
	});
	const approved = rows.filter((row): row is typeof row & { revisionId: string } => row.reviewStatus === 'approved' && !!row.revisionId);
	const current =
		approved.find((row) => row.role === 'scan' && row.isCurrent) ??
		approved.find((row) => row.isCurrent) ??
		approved.find((row) => row.role === 'scan') ??
		approved[0];
	if (!current) return { detail, unavailable: true as const };

	const revision = await getRevision(db, current.revisionId, principal);
	// A revision whose page count was never recorded used to clamp every
	// request to page 1, so a link to page 50 silently opened the cover and
	// cited it as page 1. An unknown count now clamps nothing.
	const recordedPageCount = revision.pageCount ?? null;
	const pageCount = Math.max(1, recordedPageCount ?? 1);
	const initialPage = clampPage(requestedPage ?? 1, recordedPageCount);
	const pending = await pendingForSource(slug, principal.userId, archiveRoleAtLeast(principal.role, 'archive_reviewer'));

	return {
		detail,
		unavailable: false as const,
		file: {
			fileId: current.fileId,
			role: current.role,
			label: current.label,
			checkoutPath: current.checkoutPath,
			revisionId: current.revisionId
		},
		revision: {
			id: revision.id,
			revisionNo: revision.revisionNo,
			pageCount,
			bytes: revision.bytes,
			sha256: revision.sha256,
			mediaType: revision.detectedMediaType,
			originalFilename: revision.originalFilename
		},
		files: approved.map((row) => ({
			fileId: row.fileId,
			role: row.role,
			label: row.label,
			checkoutPath: row.checkoutPath,
			revisionId: row.revisionId,
			revisionNo: row.revisionNo,
			bytes: row.bytes,
			mediaType: row.mediaType,
			sha256: row.sha256,
			submittedAt: row.submittedAt?.toISOString() ?? null
		})),
		revisions: rows
			.filter((row): row is typeof row & { revisionId: string } => !!row.revisionId)
			.map((row) => ({
				revisionId: row.revisionId,
				revisionNo: row.revisionNo,
				reviewStatus: row.reviewStatus,
				submittedAt: row.submittedAt?.toISOString() ?? null,
				sha256: row.sha256
			})),
		pending,
		initialPage
	};
}

/** Exposed for tests: the clamp is easy to get wrong and hard to see fail. */
export const clampPageForTest = (page: number, pageCount: number | null) => clampPage(page, pageCount);

function clampPage(page: number, pageCount: number | null): number {
	const atLeastFirst = Math.max(1, page);
	return pageCount == null ? atLeastFirst : Math.min(atLeastFirst, pageCount);
}

async function pendingForSource(slug: string, userId: string, canSeeAll: boolean) {
	const clauses = [eq(sources.slug, slug), eq(fileRevisions.reviewStatus, 'pending')];
	if (!canSeeAll) clauses.push(eq(fileRevisions.submittedBy, userId));
	const rows = await db
		.select({
			revisionId: fileRevisions.id,
			title: sources.title,
			fileRole: sourceFiles.role,
			filename: fileRevisions.originalFilename,
			bytes: archiveBlobs.bytes,
			submittedAt: fileRevisions.submittedAt,
			uploader: fileRevisions.submittedBy
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(and(...clauses))
		.orderBy(desc(fileRevisions.submittedAt));
	return rows.map((row) => ({
		...row,
		submittedAt: row.submittedAt?.toISOString() ?? null,
		canWithdraw: row.uploader === userId
	}));
}
