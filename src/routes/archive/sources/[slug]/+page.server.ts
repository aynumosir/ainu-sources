import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { archiveBlobs, fileRevisions, sourceFiles, sources } from '$lib/server/db/schema';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { listSourceFiles } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { getSourceDetail } from '$lib/server/queries';

export const load: PageServerLoad = async ({ request, params }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, detail: null, files: [], pending: [], revisions: [] };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const files = await listSourceFiles(db, params.slug, principal, {
		includeHistory: archiveRoleAtLeast(principal.role, 'archive_reviewer')
	});
	const pending = await pendingForSource(params.slug, principal.userId, archiveRoleAtLeast(principal.role, 'archive_reviewer'));
	const revisions = files
		.filter((file) => file.revisionId)
		.map((file) => ({
			revisionId: file.revisionId,
			revisionNo: file.revisionNo,
			reviewStatus: file.reviewStatus,
			submittedAt: file.submittedAt ? new Date(file.submittedAt).toISOString() : null,
			sha256: file.sha256
		}));

	return { accessDenied: false, detail, files, pending, revisions };
};

async function pendingForSource(slug: string, userId: string, canSeeAll: boolean) {
	const clauses = [
		eq(sources.slug, slug),
		eq(fileRevisions.reviewStatus, 'pending')
	];
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
