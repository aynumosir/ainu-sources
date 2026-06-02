import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';
import { buildCitation, toCSL } from '$lib/server/cite';

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	// CSL-JSON is an array of citation items.
	return json([toCSL(buildCitation(detail, params.slug))]);
};
