import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { SITE_ORIGIN } from '$lib/seo';
import { getSitemapSources } from '$lib/server/queries';
import {
	EmptySitemapError,
	emptySitemapResponse,
	SitemapLimitError,
	sitemapCapacityResponse,
	sitemapQueryRedirect,
	urlsetResponse
} from '$lib/server/sitemap';
import {
	findSourceSitemapShard,
	SITEMAP_LOGICAL_ENTRY_LIMIT
} from '$lib/server/sitemap-manifest';

export const GET: RequestHandler = async ({ params, url }) => {
	const redirect = sitemapQueryRedirect(url);
	if (redirect) return redirect;

	const shard = findSourceSitemapShard(params.shard);
	if (!shard) throw error(404, 'Unknown sitemap shard');

	const rows = await getSitemapSources(shard);
	if (rows.length > SITEMAP_LOGICAL_ENTRY_LIMIT) return sitemapCapacityResponse();

	try {
		return urlsetResponse(
			SITE_ORIGIN,
			rows.map((source) => ({
				path: `/sources/${source.slug}`,
				lastmod: source.updatedAt,
				changefreq: 'monthly',
				priority: 0.8
			}))
		);
	} catch (cause) {
		if (cause instanceof EmptySitemapError) return emptySitemapResponse();
		if (cause instanceof SitemapLimitError) return sitemapCapacityResponse();
		throw cause;
	}
};
