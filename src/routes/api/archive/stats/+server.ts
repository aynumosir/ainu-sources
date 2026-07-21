/**
 * GET /api/archive/stats — return briefly cached collection aggregates.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { getArchiveStats } from '$lib/server/archive/stats';

export const GET: RequestHandler = async ({ request, locals }) => {
	const db = routeDb(locals);
	await archivePrincipal(request, 'archive_reader', db);
	try {
		return json(await getArchiveStats(db), {
			headers: { 'cache-control': 'private, max-age=60' }
		});
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
