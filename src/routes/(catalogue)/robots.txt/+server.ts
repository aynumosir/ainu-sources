import type { RequestHandler } from './$types';

/**
 * Private / non-content routes carry `noindex` via the page itself, and staying
 * crawlable is what lets a crawler read that tag, so they are not listed here.
 *
 * The two exceptions below are routes where no crawler ever reaches a noindex tag,
 * because a signed-out visitor is redirected before the page renders. `/edit` is
 * linked from every source page and answers anonymously with a 302 to
 * `/login?redirect=<that path>`, which mints one distinct login URL per source per
 * locale — around 17,000 of them for a catalogue of 4,214 works. Meta's crawler
 * fetched 16,389 of those in a single six-hour window, more than any other route on
 * the site, to be told each time that it must sign in. Disallowing them withholds
 * nothing a crawler could have indexed.
 */
export const GET: RequestHandler = ({ url }) => {
	const body = `User-agent: *
Allow: /
Disallow: /api/
Disallow: /*/edit
Disallow: /*?redirect=

Sitemap: ${url.origin}/sitemap.xml
`;
	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
