/**
 * POST /api/archive/revisions/<id>/withdraw — contributor withdrawal for their
 * own pending revision.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { withdrawRevision } from '$lib/server/archive/db';
import { archiveMutationPrincipal, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	try {
		return json({ revision: await withdrawRevision(db, params.id, principal) });
	} catch (e) {
		throwArchiveError(e);
	}
};
