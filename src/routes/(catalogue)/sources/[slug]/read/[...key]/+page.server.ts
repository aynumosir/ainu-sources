import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSourceBySlug, getMergeRedirectTarget } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { getCorpusFetcher, getTextDocument } from '$lib/server/corpus';
import { READER_PAGE_SIZE, keySegments, pageCountOf, readerHref } from '$lib/text-reader/keys';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const key = keySegments(params.key).join('/');
	const source = await getSourceBySlug(params.slug);
	if (!source) {
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, readerHref(target, key));
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, readerHref(renamed, key));
		error(404, 'Source not found');
	}

	const requested = Math.trunc(Number(url.searchParams.get('page') ?? '1'));
	const pageNo = Number.isFinite(requested) && requested > 1 ? requested : 1;

	const text = await getTextDocument(getCorpusFetcher(platform?.env), source.slug, key, {
		offset: (pageNo - 1) * READER_PAGE_SIZE,
		limit: READER_PAGE_SIZE
	});
	if (!text) error(404, 'Text not found');

	const pageCount = pageCountOf(text.total, READER_PAGE_SIZE);
	if (pageNo > pageCount) redirect(302, readerHref(source.slug, key, pageCount));

	return {
		source: { slug: source.slug, title: source.title, titleEn: source.titleEn, author: source.author },
		text,
		pageNo,
		pageCount
	};
};
