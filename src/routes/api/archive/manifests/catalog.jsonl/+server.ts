/**
 * GET /api/archive/manifests/catalog.jsonl — generate the all-repository
 * archive manifest from approved current revisions.
 */
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { renderManifest } from '$lib/server/archive/manifest';

export const GET: RequestHandler = async ({ request }) => {
	await archivePrincipal(request, 'archive_reader');
	try {
		const manifest = await renderManifest(db);
		if (request.headers.get('if-none-match') === manifest.etag) return new Response(null, { status: 304 });
		return new Response(manifest.body, {
			headers: { 'content-type': 'application/jsonl; charset=utf-8', 'etag': manifest.etag }
		});
	} catch (e) {
		throwArchiveError(e);
	}
};
