import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { getSourceBySlug, getMergeRedirectTarget } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { getCorpusFetcher, getTextDocument } from '$lib/server/corpus';
import { READER_PAGE_SIZE, keySegments, pageCountOf, readerHref } from '$lib/text-reader/keys';

export const load: PageServerLoad = async ({ params, url, platform }) => {
	const key = keySegments(params.key).join('/');
	// One address per document: doubled or trailing slashes go to the plain key.
	if (key !== params.key) redirect(301, `${readerHref(params.slug, key)}${url.search}`);
	const source = await getSourceBySlug(params.slug);
	if (!source) {
		const target = await getMergeRedirectTarget(params.slug);
		if (target) redirect(302, readerHref(target, key));
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, readerHref(renamed, key));
		error(404, 'Source not found');
	}

	// One address per part: the first part has no query, and a page value that
	// is not a whole number above one goes back to it.
	const pageParam = url.searchParams.get('page');
	const requested = pageParam == null ? 1 : Number(pageParam);
	const pageNo = Number.isInteger(requested) && requested > 1 ? requested : 1;
	if (pageParam != null && (pageNo === 1 || String(pageNo) !== pageParam)) redirect(301, readerHref(params.slug, key, pageNo));

	const r = await getTextDocument(getCorpusFetcher(platform?.env), source.slug, key, {
		offset: (pageNo - 1) * READER_PAGE_SIZE,
		limit: READER_PAGE_SIZE
	});
	if (!r.ok) {
		if (r.reason === 'unreachable') error(503, 'The corpus is not reachable right now');
		error(404, 'Text not found');
	}
	const text = r.data;

	const pageCount = pageCountOf(text.total, text.limit);
	if (pageNo > pageCount) redirect(302, readerHref(source.slug, key, pageCount));

	return {
		source: { slug: source.slug, title: source.title, titleEn: source.titleEn, author: source.author },
		text,
		pageNo,
		pageCount
	};
};
