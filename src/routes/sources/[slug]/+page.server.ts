import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getSourceDetail } from '$lib/server/queries';
import { buildCitation, toReference } from '$lib/server/cite';

export const load: PageServerLoad = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	// A human-readable reference string for the Cite panel (copy-to-clipboard).
	const citation = toReference(buildCitation(detail, params.slug));
	return { detail, citation };
};
