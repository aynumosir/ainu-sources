/**
 * POST /api/archive/revisions/<id>/approve — reviewer decision that promotes
 * one pending revision to the current approved revision transactionally.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { approveRevision } from '$lib/server/archive/db';
import { archiveMutationPrincipal, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_reviewer');
	try {
		return json({ revision: await approveRevision(db, params.id, principal) });
	} catch (e) {
		throwArchiveError(e);
	}
};
