/**
 * GET /api/archive/sources/<slug>/files — list archive file slots for one
 * source. Readers see approved current revisions; reviewers also see pending
 * material for review.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { listSourceFiles } from '$lib/server/archive/db';

export const GET: RequestHandler = async ({ request, params, url }) => {
	const principal = await archivePrincipal(request, 'archive_reader');
	try {
		return json({
			files: await listSourceFiles(db, params.slug, principal, {
				role: url.searchParams.get('role'),
				includeHistory: parseIncludeHistory(url.searchParams.get('include_history'))
			})
		});
	} catch (e) {
		throwArchiveError(e);
	}
};

function parseIncludeHistory(value: string | null): boolean {
	return value === 'true' || value === '1';
}
