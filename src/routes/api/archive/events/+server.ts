/**
 * GET /api/archive/events — admin-only cursor over generic archive audit
 * events carried by the shared event ledger.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { listArchiveEvents } from '$lib/server/archive/db';

export const GET: RequestHandler = async ({ request, url }) => {
	await archivePrincipal(request, 'archive_admin');
	try {
		return json(await listArchiveEvents(db, url.searchParams.get('cursor')));
	} catch (e) {
		throwArchiveError(e);
	}
};
