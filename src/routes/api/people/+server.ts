/**
 * GET /api/people — one chunk of the people list.
 *
 * Query params (all optional): q, role, sort (count | name | name-desc),
 * offset. Answers `PERSON_PAGE_SIZE` rows from `offset` plus the matching
 * total, in the shape the /people page renders, so the page can append chunks
 * as the visitor scrolls. Offsets past `PERSON_MAX_OFFSET` are 404.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { parsePeopleQuery, loadPeopleChunk } from '$lib/server/people-list';

export const GET: RequestHandler = async ({ url }) => {
	const query = parsePeopleQuery(url.searchParams);
	if (query === undefined) throw error(404, 'offset out of range');
	return json(await loadPeopleChunk(query), {
		headers: { 'cache-control': 'public, max-age=300' }
	});
};
