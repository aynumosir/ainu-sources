/**
 * GET /api/archive/revisions/<id>/text — return ingested OCR text for a
 * readable archive revision, with page-selector and cursor pagination.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getRevisionForContent } from '$lib/server/archive/db';
import { getRevisionText } from '$lib/server/archive/ocr';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, params, url }) => {
	const principal = await archivePrincipal(request, 'archive_reader');
	try {
		const revision = await getRevisionForContent(db, params.id, principal);
		return json(
			await getRevisionText(db, revision.id, revision.pageCount, {
				variant: url.searchParams.get('variant'),
				pages: url.searchParams.get('pages'),
				cursor: url.searchParams.get('cursor')
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};
