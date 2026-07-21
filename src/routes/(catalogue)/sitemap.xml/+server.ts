import type { RequestHandler } from './$types';
import { getSitemapEntries } from '$lib/server/queries';
import { hreflangAlternates } from '$lib/seo';

const xml = (s: string) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

interface Entry {
	path: string; // bare (locale-stripped) path
	lastmod?: Date | null;
	changefreq?: string;
	priority?: number;
}

function urlNode(origin: string, e: Entry): string {
	// loc points at the base-locale (unprefixed) URL; xhtml:link lists every locale.
	const alts = hreflangAlternates(origin, e.path);
	const loc = alts.find((a) => a.hreflang === 'x-default')!.href;
	const links = alts
		.map((a) => `\n\t\t<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${xml(a.href)}" />`)
		.join('');
	const lastmod = e.lastmod ? `\n\t\t<lastmod>${new Date(e.lastmod).toISOString()}</lastmod>` : '';
	const changefreq = e.changefreq ? `\n\t\t<changefreq>${e.changefreq}</changefreq>` : '';
	const priority = e.priority != null ? `\n\t\t<priority>${e.priority.toFixed(1)}</priority>` : '';
	return `\t<url>\n\t\t<loc>${xml(loc)}</loc>${links}${lastmod}${changefreq}${priority}\n\t</url>`;
}

export const GET: RequestHandler = async ({ url }) => {
	const origin = url.origin;
	const { sources, persons, places, institutions } = await getSitemapEntries();

	const staticPages: Entry[] = [
		{ path: '/', changefreq: 'daily', priority: 1.0 },
		{ path: '/sources', changefreq: 'daily', priority: 0.9 },
		{ path: '/timeline', changefreq: 'weekly', priority: 0.6 },
		{ path: '/map', changefreq: 'weekly', priority: 0.6 },
		{ path: '/people', changefreq: 'weekly', priority: 0.7 },
		{ path: '/places', changefreq: 'weekly', priority: 0.7 },
		{ path: '/institutions', changefreq: 'weekly', priority: 0.7 },
		{ path: '/about', changefreq: 'monthly', priority: 0.4 }
	];

	const entries: Entry[] = [
		...staticPages,
		...sources.map((s) => ({ path: `/sources/${s.slug}`, lastmod: s.updatedAt, changefreq: 'monthly', priority: 0.8 })),
		...persons.map((p) => ({ path: `/people/${p.slug}`, lastmod: p.updatedAt, changefreq: 'monthly', priority: 0.5 })),
		...places.map((p) => ({ path: `/places/${p.slug}`, changefreq: 'monthly', priority: 0.5 })),
		...institutions.map((i) => ({ path: `/institutions/${i.slug}`, changefreq: 'monthly', priority: 0.5 }))
	];

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.map((e) => urlNode(origin, e)).join('\n')}
</urlset>
`;

	return new Response(body, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
		}
	});
};
