/**
 * GET /api/archive/files/<fileId> — resolve a file slot to its source and
 * current/pending revision ids.
 *
 * This dedicated lookup keeps /api/archive/revisions/<id>/text keyed by a
 * revision id. Accepting file_id on that text route would make the path
 * segment's identifier type depend on a query parameter, so callers perform
 * one resolution hop when they start from a file id. The current MCP
 * source_file_text tool does not call this route yet; it still asks callers to
 * pass revision_id. Updating that tool is a separate ainu-mcp change.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getSourceFileById } from '$lib/server/archive/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, params }) => {
	const principal = await archivePrincipal(request, 'archive_reader');
	try {
		return json(await getSourceFileById(db, params.fileId, principal));
	} catch (e) {
		throwArchiveError(e);
	}
};
