/**
 * GET /api/archive/repositories — list admin-curated checkout repositories.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { listArchiveRepositories } from '$lib/server/archive/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, locals }) => {
	const db = routeDb(locals);
	await archivePrincipal(request, 'archive_reader', db);
	try {
		return json(await listArchiveRepositories(db));
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
