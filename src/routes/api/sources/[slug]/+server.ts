/**
 * GET /api/sources/<slug> — full detail for one source: the source record plus
 * its linked persons, places, institutions, digital links, relations and tags.
 * Reuses `getSourceDetail()` — the same loader the /sources/[slug] page uses.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';

const CORS = { 'access-control-allow-origin': '*' } as const;

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) throw error(404, `no source with slug ${params.slug}`);
	return json(detail, { headers: CORS });
};
