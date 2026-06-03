/**
 * GET /api/network — the citation network of the catalogue, with each work's
 * PageRank significance + citation in/out-degree. Feeds the /network 3D graph.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCitationNetwork } from '$lib/server/network';

export const GET: RequestHandler = async () => {
	const data = await getCitationNetwork();
	return json(data, {
		headers: {
			'access-control-allow-origin': '*',
			'cache-control': 'public, max-age=3600'
		}
	});
};
