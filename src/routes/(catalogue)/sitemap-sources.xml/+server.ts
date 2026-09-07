import type { RequestHandler } from './$types';
import { getSitemapSources } from '$lib/server/queries';
import { urlsetXml, xmlResponse } from '$lib/server/sitemap';

/** One <url> per source detail page per locale. */
export const GET: RequestHandler = async ({ url }) => {
	const rows = await getSitemapSources();
	return xmlResponse(
		urlsetXml(
			url.origin,
			rows.map((s) => ({
				path: `/sources/${s.slug}`,
				lastmod: s.updatedAt,
				changefreq: 'monthly',
				priority: 0.8
			}))
		)
	);
};
