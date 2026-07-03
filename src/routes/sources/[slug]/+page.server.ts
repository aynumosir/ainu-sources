import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSourceDetail, getMergeRedirectTarget } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toReference } from '$lib/server/cite';

export const load: PageServerLoad = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		// A merged loser permanently redirects to its (active) winner; a RENAMED
		// slug 301s to the same source's current slug; hidden, soft_deleted,
		// candidate, or genuinely-missing slugs are 404 to the public.
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, `/sources/${target}`);
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}`);
		error(404, 'Source not found');
	}

	// A human-readable reference string for the Cite panel (copy-to-clipboard).
	const citation = toReference(buildCitation(detail, params.slug));
	return { detail, citation };
};
