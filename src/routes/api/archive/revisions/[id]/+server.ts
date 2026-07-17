/**
 * GET /api/archive/revisions/<id> — return one archive revision's metadata
 * after applying the same role visibility rules as the catalogue.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { getRevision } from '$lib/server/archive/db';

export const GET: RequestHandler = async ({ request, params }) => {
	const principal = await archivePrincipal(request, 'archive_reader');
	try {
		return json(await getRevision(db, params.id, principal));
	} catch (e) {
		throwArchiveError(e);
	}
};
