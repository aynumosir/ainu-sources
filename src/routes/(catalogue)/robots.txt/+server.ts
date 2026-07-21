import type { RequestHandler } from './$types';

/**
 * Private / non-content routes carry `noindex` via the page itself; here we only
 * keep crawlers out of the JSON API and advertise the sitemap. (We intentionally
 * do NOT Disallow the noindex pages, so crawlers can still see the noindex tag.)
 */
export const GET: RequestHandler = ({ url }) => {
	const body = `User-agent: *
Allow: /
Disallow: /api/

Sitemap: ${url.origin}/sitemap.xml
`;
	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
