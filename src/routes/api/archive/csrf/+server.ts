/**
 * GET /api/archive/csrf — issue a session-bound mutation token. Mutating
 * routes must echo the token in the X-Archive-CSRF request header.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { archiveCsrfExpiresAt, issueArchiveCsrfToken } from '$lib/server/archive/csrf';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, locals }) => {
	const principal = await archivePrincipal(request, 'archive_reader', routeDb(locals));
	try {
		if (principal.authn === 'mcp_assertion') {
			throw new ArchiveHttpError(403, 'assertion-authenticated principals cannot issue CSRF tokens');
		}
		const now = new Date();
		return json({
			token: await issueArchiveCsrfToken(principal.userId, now),
			expires_at: archiveCsrfExpiresAt(now).toISOString()
		});
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
