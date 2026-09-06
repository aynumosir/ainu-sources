import type { RequestHandler } from './$types';
import { sitemapIndexXml, xmlResponse } from '$lib/server/sitemap';

/** Sitemap index: points crawlers at the per-section child sitemaps. */
export const GET: RequestHandler = async ({ url }) => {
	const lastmod = new Date().toISOString().slice(0, 10);
	return xmlResponse(
		sitemapIndexXml(url.origin, [
			{ path: '/sitemap-pages.xml', lastmod },
			{ path: '/sitemap-sources.xml', lastmod },
			{ path: '/sitemap-entities.xml', lastmod }
		])
	);
};
