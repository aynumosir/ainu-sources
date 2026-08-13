/**
 * Edge caching for the public catalogue.
 *
 * Measured on production, a request spends about 4% of its wall clock on CPU and
 * the rest waiting on the database, and latency rises with concurrent load. The
 * load is a scraper distributed over 623 client IPs across a dozen countries,
 * rotating browser user agents, 1–3 requests apiece — which robots.txt cannot
 * reach and per-IP limits cannot separate from real readers. A cached page costs
 * no round trips no matter who asks, so a reader's own request stops queueing
 * behind it.
 *
 * Two rules keep this from serving one visitor's view to another:
 *
 *   1. An explicit ALLOW-LIST of paths. Anything not named here — /archive, /login,
 *      /account, every form POST target — is never stored, so a route added later
 *      is uncached until someone decides otherwise. A deny-list would fail open.
 *   2. Anonymous requests only. These pages do vary by viewer: the catalogue layout
 *      reports `hasArchiveAccess`, so a signed-in researcher sees a reader link an
 *      anonymous visitor does not. A request carrying a session cookie skips the
 *      cache in both directions — never served from it, never stored into it.
 */
import type { Handle } from '@sveltejs/kit';

/** Five minutes: long enough to absorb a scrape, short enough that an edit lands. */
export const EDGE_TTL_SECONDS = 300;

/** Paths whose response is identical for every anonymous visitor. */
const CACHEABLE = [
	/^\/sources$/u,
	/^\/sources\/[^/]+$/u,
	/^\/sources\/[^/]+\/cite\.(?:bib|json|yml|yaml|ris)$/u,
	/^\/people$/u,
	/^\/people\/[^/]+$/u,
	/^\/places$/u,
	/^\/places\/[^/]+$/u,
	/^\/institutions$/u,
	/^\/institutions\/[^/]+$/u,
	/^\/timeline$/u,
	/^\/map$/u,
	/^\/network$/u
];

const LOCALE_PREFIX = /^\/(?:ja|ru|ain|en)(?=\/|$)/u;

/** Strip the locale segment so one rule covers /sources and /ja/sources alike. */
export function withoutLocale(pathname: string): string {
	const bare = pathname.replace(LOCALE_PREFIX, '');
	return bare === '' ? '/' : bare;
}

export function isCacheablePath(pathname: string): boolean {
	const bare = withoutLocale(pathname);
	return CACHEABLE.some((pattern) => pattern.test(bare));
}

/**
 * Whether the request carries a signed-in session. better-auth names the cookie
 * `better-auth.session_token`, and prefixes it `__Secure-` over HTTPS; matching the
 * suffix covers both without pinning the prefix.
 */
export function hasSessionCookie(request: Request): boolean {
	const cookie = request.headers.get('cookie');
	if (!cookie) return false;
	return /(?:^|;\s*)(?:__Secure-|__Host-)?better-auth\.session_token=/u.test(cookie);
}

/** Everything that must hold before a response may be shared between visitors. */
export function isCacheableRequest(request: Request, url: URL): boolean {
	return request.method === 'GET' && !hasSessionCookie(request) && isCacheablePath(url.pathname);
}

/**
 * The two methods used here. `caches.default` is a Workers extension that the DOM's
 * `CacheStorage` does not declare, so the surface is named rather than depending on
 * ambient Workers types being in scope.
 */
export interface EdgeCache {
	match(request: Request): Promise<Response | undefined>;
	put(request: Request, response: Response): Promise<void>;
}

/** Absent outside Workers — `bun run dev` and the test suite simply skip caching. */
export function edgeCache(platform: App.Platform | undefined): EdgeCache | undefined {
	return (platform?.caches as { default?: EdgeCache } | undefined)?.default;
}

export const handleEdgeCache: Handle = async ({ event, resolve }) => {
	if (!isCacheableRequest(event.request, event.url)) return resolve(event);

	const cache = edgeCache(event.platform);
	if (!cache) return resolve(event);

	// The URL is the whole key. Locale comes from the path and nothing else: every URL
	// matches one of paraglide's `urlPatterns`, with `en` mapped to the unprefixed form,
	// so the `url` strategy always resolves before `cookie` or `preferredLanguage` is
	// consulted. `/sources` renders English for every visitor whatever their
	// `Accept-Language` or `PARAGLIDE_LOCALE` says.
	const key = new Request(event.url.toString(), { method: 'GET' });
	const hit = await cache.match(key);
	if (hit) return hit;

	const response = await resolve(event);
	if (response.status !== 200) return response;

	const cacheable = new Response(response.body, response);
	// `max-age=0` reads as "do not store" to the Cache API, and `put()` resolves to
	// undefined whether or not it stored, so asking for it that way discarded every
	// entry in silence and made this whole path a per-request cost with no hit.
	cacheable.headers.set('cache-control', `public, max-age=${EDGE_TTL_SECONDS}`);
	// Load-bearing, not decoration. The adapter's own worker entry stores any response
	// carrying `cache-control` into `caches.default` under the bare request, and reads
	// that store before this hook runs. Without `Vary: Cookie` a signed-in reader's
	// request would match the anonymous entry there and be served a page that reports
	// no archive access — the guard at the top of this hook never gets to see it.
	cacheable.headers.append('vary', 'Cookie');
	event.platform?.ctx?.waitUntil(cache.put(key, cacheable.clone()));
	return cacheable;
};
