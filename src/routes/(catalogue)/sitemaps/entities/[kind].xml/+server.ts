import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SITE_ORIGIN } from '$lib/seo';
import { getSitemapEntities } from '$lib/server/queries';
import {
	EmptySitemapError,
	emptySitemapResponse,
	SitemapLimitError,
	sitemapCapacityResponse,
	sitemapQueryRedirect,
	urlsetResponse
} from '$lib/server/sitemap';
import {
	findEntitySitemapChild,
	SITEMAP_LOGICAL_ENTRY_LIMIT
} from '$lib/server/sitemap-manifest';

export const GET: RequestHandler = async ({ params, url }) => {
	const redirect = sitemapQueryRedirect(url);
	if (redirect) return redirect;

	const child = findEntitySitemapChild(params.kind);
	if (!child) throw error(404, 'Unknown sitemap entity type');

	const rows = await getSitemapEntities(child.kind);
	if (rows.length > SITEMAP_LOGICAL_ENTRY_LIMIT) return sitemapCapacityResponse();

	try {
		return urlsetResponse(
			SITE_ORIGIN,
			rows.map((entity) => ({
				path: `${child.detailPath}/${entity.slug}`,
				lastmod: entity.updatedAt,
				changefreq: 'monthly',
				priority: 0.5
			}))
		);
	} catch (cause) {
		if (cause instanceof EmptySitemapError) return emptySitemapResponse();
		if (cause instanceof SitemapLimitError) return sitemapCapacityResponse();
		throw cause;
	}
};
