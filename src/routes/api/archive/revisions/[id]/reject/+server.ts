/**
 * POST /api/archive/revisions/<id>/reject — reviewer rejection for a pending
 * revision. A note is required so the contributor has a reason.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { rejectRevision } from '$lib/server/archive/db';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_reviewer');
	const body = await readJsonObject(request);
	try {
		return json({ revision: await rejectRevision(db, params.id, principal, String(body.note ?? '')) });
	} catch (e) {
		throwArchiveError(e);
	}
};
