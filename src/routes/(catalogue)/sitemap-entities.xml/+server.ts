import type { RequestHandler } from './$types';
import { getSitemapEntities } from '$lib/server/queries';
import { urlsetXml, xmlResponse, type SitemapEntry } from '$lib/server/sitemap';

/** People, places and institution detail pages, one <url> each per locale. */
export const GET: RequestHandler = async ({ url }) => {
	const { persons, places, institutions } = await getSitemapEntities();
	const entries: SitemapEntry[] = [
		...persons.map((p) => ({
			path: `/people/${p.slug}`,
			lastmod: p.updatedAt,
			changefreq: 'monthly',
			priority: 0.5
		})),
		...places.map((p) => ({ path: `/places/${p.slug}`, changefreq: 'monthly', priority: 0.5 })),
		...institutions.map((i) => ({
			path: `/institutions/${i.slug}`,
			changefreq: 'monthly',
			priority: 0.5
		}))
	];
	return xmlResponse(urlsetXml(url.origin, entries));
};
