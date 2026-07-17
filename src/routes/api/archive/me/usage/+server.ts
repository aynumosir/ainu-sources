/**
 * GET /api/archive/me/usage — current caller's UTC-day byte budget and active
 * stream lease usage.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { getUsageSummary } from '$lib/server/archive/db';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, locals }) => {
	const db = routeDb(locals);
	const principal = await archivePrincipal(request, 'archive_reader', db);
	try {
		if (principal.authn === 'mcp_assertion') {
			throw new ArchiveHttpError(403, 'assertion-authenticated principals cannot read usage summaries');
		}
		return json(await getUsageSummary(db, principal));
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
