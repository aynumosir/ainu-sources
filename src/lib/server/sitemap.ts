// Sitemap building blocks shared by /sitemap.xml (an index) and its per-section
// children (pages, sources, entities). The catalogue is multilingual: every
// path is listed once per locale as its own <url>, each carrying the full
// reciprocal hreflang cluster, so all language versions of a page are
// individually discoverable. Splitting by section keeps each child small and
// lets crawlers refetch the fast-changing source list independently of the
// static pages and entity directories.

import { locales } from '$lib/paraglide/runtime';
import { hreflangAlternates } from '$lib/seo';

export interface SitemapEntry {
	/** Bare (locale-stripped) path, e.g. `/sources/kindaichi-1931`. */
	path: string;
	lastmod?: Date | string | null;
	changefreq?: string;
	priority?: number;
}

const esc = (s: string) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

/** A <urlset> with one <url> per entry per locale. */
export function urlsetXml(origin: string, entries: SitemapEntry[]): string {
	const urls = entries.flatMap((e) => {
		const alts = hreflangAlternates(origin, e.path);
		const links = alts
			.map(
				(a) =>
					`\n\t\t<xhtml:link rel="alternate" hreflang="${a.hreflang}" href="${esc(a.href)}" />`
			)
			.join('');
		const lastmod = e.lastmod
			? `\n\t\t<lastmod>${new Date(e.lastmod).toISOString()}</lastmod>`
			: '';
		const changefreq = e.changefreq ? `\n\t\t<changefreq>${e.changefreq}</changefreq>` : '';
		const priority =
			e.priority != null ? `\n\t\t<priority>${e.priority.toFixed(1)}</priority>` : '';
		return locales.map((loc) => {
			const href = alts.find((a) => a.hreflang === loc)!.href;
			return `\t<url>\n\t\t<loc>${esc(href)}</loc>${links}${lastmod}${changefreq}${priority}\n\t</url>`;
		});
	});
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join('\n')}
</urlset>
`;
}

/** A <sitemapindex> pointing crawlers at the child sitemaps. */
export function sitemapIndexXml(origin: string, children: { path: string; lastmod?: string }[]): string {
	const nodes = children.map((c) => {
		const lastmod = c.lastmod ? `\n\t\t<lastmod>${c.lastmod}</lastmod>` : '';
		return `\t<sitemap>\n\t\t<loc>${esc(new URL(c.path, origin).href)}</loc>${lastmod}\n\t</sitemap>`;
	});
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${nodes.join('\n')}
</sitemapindex>
`;
}

export const xmlResponse = (body: string) =>
	new Response(body, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400'
		}
	});
