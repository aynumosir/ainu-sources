/**
 * GET /api/archive/files — cursor-paginated catalogue over approved current
 * archive files across sources.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { listFiles } from '$lib/server/archive/db';

export const GET: RequestHandler = async ({ request, url }) => {
	await archivePrincipal(request, 'archive_reader');
	try {
		return json(
			await listFiles(db, url.searchParams.get('cursor'), url.searchParams.get('updated_since'), 50, {
				role: url.searchParams.get('role'),
				includeHistory: parseIncludeHistory(url.searchParams.get('include_history'))
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};

function parseIncludeHistory(value: string | null): boolean {
	return value === 'true' || value === '1';
}
