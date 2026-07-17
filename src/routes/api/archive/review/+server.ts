/**
 * GET /api/archive/review — reviewer queue for pending revisions, including
 * blob and source fields needed for inspection. Queue cards pass include=full
 * to get duplicate and revision-history context in one response.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { listPendingReview } from '$lib/server/archive/db';

export const GET: RequestHandler = async ({ request, url }) => {
	await archivePrincipal(request, 'archive_reviewer');
	try {
		return json(
			await listPendingReview(db, url.searchParams.get('cursor'), 50, {
				include: url.searchParams.get('include') === 'full' ? 'full' : undefined
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};
