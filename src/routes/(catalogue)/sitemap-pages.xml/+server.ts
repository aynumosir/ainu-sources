import type { RequestHandler } from './$types';
import { urlsetXml, xmlResponse, type SitemapEntry } from '$lib/server/sitemap';

/** Fixed catalogue pages (directories and views). Detail pages live in the
 *  sources / entities children. */
const staticPages: SitemapEntry[] = [
	{ path: '/', changefreq: 'daily', priority: 1.0 },
	{ path: '/records', changefreq: 'weekly', priority: 0.7 },
	{ path: '/sources', changefreq: 'daily', priority: 0.9 },
	{ path: '/people', changefreq: 'weekly', priority: 0.7 },
	{ path: '/places', changefreq: 'weekly', priority: 0.7 },
	{ path: '/institutions', changefreq: 'weekly', priority: 0.7 },
	{ path: '/timeline', changefreq: 'weekly', priority: 0.6 },
	{ path: '/map', changefreq: 'weekly', priority: 0.6 },
	{ path: '/network', changefreq: 'weekly', priority: 0.6 },
	{ path: '/about', changefreq: 'monthly', priority: 0.4 }
];

export const GET: RequestHandler = async ({ url }) =>
	xmlResponse(urlsetXml(url.origin, staticPages));
