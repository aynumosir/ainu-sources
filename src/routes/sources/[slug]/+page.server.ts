import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { getSourceDetail, getMergeRedirectTarget } from '$lib/server/queries';
import { buildCitation, toReference } from '$lib/server/cite';

export const load: PageServerLoad = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		// A merged loser permanently redirects to its (active) winner; hidden,
		// soft_deleted, candidate, or genuinely-missing slugs are 404 to the public.
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, `/sources/${target}`);
		error(404, 'Source not found');
	}

	// A human-readable reference string for the Cite panel (copy-to-clipboard).
	const citation = toReference(buildCitation(detail, params.slug));
	return { detail, citation };
};
