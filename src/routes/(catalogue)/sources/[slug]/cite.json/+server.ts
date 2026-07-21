import { json, error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getSourceDetail } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toCSL } from '$lib/server/cite';

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}/cite.json`);
		error(404, 'Source not found');
	}

	// CSL-JSON is an array of citation items.
	return json([toCSL(buildCitation(detail, params.slug))]);
};
