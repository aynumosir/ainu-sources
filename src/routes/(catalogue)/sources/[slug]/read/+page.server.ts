import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSourceBySlug, getMergeRedirectTarget } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { getCorpusFetcher, getTextDocuments } from '$lib/server/corpus';

export const load: PageServerLoad = async ({ params, platform }) => {
	const source = await getSourceBySlug(params.slug);
	if (!source) {
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, `/sources/${target}/read`);
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}/read`);
		error(404, 'Source not found');
	}

	const documents = await getTextDocuments(getCorpusFetcher(platform?.env), source.slug);
	if (documents.length === 0) error(404, 'This source has no readable text');

	return {
		source: { slug: source.slug, title: source.title, titleEn: source.titleEn, titleAin: source.titleAin, author: source.author },
		documents
	};
};
