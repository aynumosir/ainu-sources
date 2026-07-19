/**
 * GET /api/archive/revisions/<id>/text — return ingested OCR text for a
 * readable archive revision, with page-selector and cursor pagination.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeContent } from '$lib/server/archive/gateway';
import { parsePageSelector } from '$lib/server/archive/ocr';
import { archivePrincipal, archiveRouteDb, throwArchiveError } from '$lib/server/archive/route';
import { getWorkspaceRevisionText } from '$lib/server/archive/workspace';

function estimateTextPages(pages: string | null): number {
	return parsePageSelector(pages)?.length ?? 50;
}

export const GET: RequestHandler = async ({ request, params, url, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archivePrincipal(request, 'archive_reader', db);
	try {
		const access = await authorizeContent(db, {
			principal,
			revisionId: params.id,
			useKind: principal.authn === 'mcp_assertion' ? 'mcp_text' : 'text',
			requestedBytes: 0,
			rateUnits: estimateTextPages(url.searchParams.get('pages'))
		});
		return json(
			await getWorkspaceRevisionText(db, access.revision.id, access.revision.pageCount, {
				variant: url.searchParams.get('variant'),
				pages: url.searchParams.get('pages'),
				cursor: url.searchParams.get('cursor')
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};
