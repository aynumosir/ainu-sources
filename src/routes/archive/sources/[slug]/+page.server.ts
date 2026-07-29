import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { listSourceFiles } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { getSourceDetail } from '$lib/server/queries';

export const load: PageServerLoad = async ({ request, params }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, detail: null, files: [], revisions: [] };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');

	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const allFiles = await listSourceFiles(db, params.slug, principal, { includeHistory: true });
	const files = allFiles.filter((file) => file.isCurrent);
	const revisions = allFiles
		.filter((file) => file.revisionId)
		.map((file) => ({
			revisionId: file.revisionId,
			revisionNo: file.revisionNo,
			submittedAt: file.submittedAt ? new Date(file.submittedAt).toISOString() : null,
			sha256: file.sha256
		}));

	return { accessDenied: false, detail, files, revisions };
};
