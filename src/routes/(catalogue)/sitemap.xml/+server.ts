import type { RequestHandler } from './$types';
import { SITE_ORIGIN } from '$lib/seo';
import { sitemapIndexXml, sitemapQueryRedirect, xmlResponse } from '$lib/server/sitemap';
import { sitemapChildPaths } from '$lib/server/sitemap-manifest';

export const GET: RequestHandler = async ({ url }) =>
	sitemapQueryRedirect(url) ??
	xmlResponse(
		sitemapIndexXml(
			SITE_ORIGIN,
			sitemapChildPaths.map((path) => ({ path }))
		)
	);
