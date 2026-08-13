import { describe, expect, it } from 'vitest';
import {
	handleEdgeCache,
	hasSessionCookie,
	isCacheablePath,
	isCacheableRequest,
	withoutLocale
} from './edge-cache';

const get = (url: string, cookie?: string) =>
	new Request(url, { method: 'GET', headers: cookie ? { cookie } : undefined });

describe('isCacheablePath', () => {
	for (const path of [
		'/sources',
		'/sources/1995-nakagawa-ainu-chitose-dialect-dictionary',
		'/sources/1995-nakagawa-ainu-chitose-dialect-dictionary/cite.bib',
		'/people',
		'/people/kawakami-yoko',
		'/places/samani',
		'/institutions',
		'/timeline',
		'/map',
		'/network',
		// same rules through every locale prefix
		'/ja/sources/1995-nakagawa-ainu-chitose-dialect-dictionary',
		'/ru/people/v-m-alpatov',
		'/ain/sources'
	])
		it(`caches ${path}`, () => expect(isCacheablePath(path)).toBe(true));

	// Anything that is private, personal, or mutating must never be stored.
	for (const path of [
		'/archive',
		'/archive/work/1995-nakagawa-ainu-chitose-dialect-dictionary/p/22',
		'/ja/archive/read/x/y',
		'/login',
		'/account',
		'/api/network',
		'/sources/1995-nakagawa-ainu-chitose-dialect-dictionary/edit',
		'/sources/1995-nakagawa-ainu-chitose-dialect-dictionary/history',
		'/admin',
		'/',
		'/ja'
	])
		it(`does not cache ${path}`, () => expect(isCacheablePath(path)).toBe(false));
});

describe('withoutLocale', () => {
	it('strips a locale segment and nothing that merely starts like one', () => {
		expect(withoutLocale('/ja/sources')).toBe('/sources');
		expect(withoutLocale('/ja')).toBe('/');
		// /japanese-loanwords is not the /ja locale
		expect(withoutLocale('/japanese-loanwords')).toBe('/japanese-loanwords');
		expect(withoutLocale('/sources')).toBe('/sources');
	});
});

describe('hasSessionCookie', () => {
	it('recognises the session cookie plain and prefixed', () => {
		expect(hasSessionCookie(get('https://db.aynu.org/sources', 'better-auth.session_token=abc'))).toBe(true);
		expect(
			hasSessionCookie(get('https://db.aynu.org/sources', '__Secure-better-auth.session_token=abc'))
		).toBe(true);
		expect(
			hasSessionCookie(get('https://db.aynu.org/sources', 'theme=dark; better-auth.session_token=abc'))
		).toBe(true);
	});

	it('is not fooled by an unrelated cookie that contains the name', () => {
		expect(hasSessionCookie(get('https://db.aynu.org/sources', 'not-better-auth.session_token_x=1'))).toBe(
			false
		);
		expect(hasSessionCookie(get('https://db.aynu.org/sources', 'theme=dark'))).toBe(false);
		expect(hasSessionCookie(get('https://db.aynu.org/sources'))).toBe(false);
	});
});

describe('isCacheableRequest', () => {
	const url = (u: string) => new URL(u);

	it('caches an anonymous GET of an allow-listed page', () => {
		const request = get('https://db.aynu.org/sources/x');
		expect(isCacheableRequest(request, url(request.url))).toBe(true);
	});

	it('never caches a signed-in visitor, who sees a different page', () => {
		// The catalogue layout reports hasArchiveAccess, so this response carries a
		// reader link that must not be handed to anyone else.
		const request = get('https://db.aynu.org/sources/x', 'better-auth.session_token=abc');
		expect(isCacheableRequest(request, url(request.url))).toBe(false);
	});

	it('never caches a non-GET', () => {
		const request = new Request('https://db.aynu.org/sources/x', { method: 'POST' });
		expect(isCacheableRequest(request, url(request.url))).toBe(false);
	});

	it('never caches the archive, signed in or not', () => {
		const anon = get('https://db.aynu.org/archive/work/x/p/22');
		expect(isCacheableRequest(anon, url(anon.url))).toBe(false);
	});

	it('keeps query strings apart rather than sharing one filter for another', () => {
		// Not a predicate check — a note that the cache key below uses the full URL.
		expect(isCacheablePath(url('https://db.aynu.org/sources?types=book').pathname)).toBe(true);
	});
});

describe('handleEdgeCache', () => {
	/** A stand-in for the Workers cache that records what it was asked to store. */
	function fakeCache() {
		const store = new Map<string, Response>();
		return {
			store,
			api: {
				match: async (key: Request) => store.get(key.url)?.clone(),
				put: async (key: Request, response: Response) => void store.set(key.url, response)
			}
		};
	}

	const runWith = async (
		url: string,
		{ cookie, status = 200, body = 'page' }: { cookie?: string; status?: number; body?: string } = {}
	) => {
		const cache = fakeCache();
		const waited: Promise<unknown>[] = [];
		const event = {
			request: get(url, cookie),
			url: new URL(url),
			platform: {
				caches: { default: cache.api },
				ctx: { waitUntil: (p: Promise<unknown>) => waited.push(p) }
			}
		} as never;
		let resolved = 0;
		const response = await handleEdgeCache({
			event,
			resolve: async () => {
				resolved += 1;
				return new Response(body, { status });
			}
		} as never);
		await Promise.all(waited);
		return { cache, response, resolved };
	};

	it('stores an anonymous page and serves the next visitor without re-rendering', async () => {
		const first = await runWith('https://db.aynu.org/sources/x');
		expect(first.resolved).toBe(1);
		expect(first.cache.store.size).toBe(1);
		expect(first.response.headers.get('cache-control')).toBe('public, max-age=300');
		expect(first.response.headers.get('vary')).toContain('Cookie');
		await expect(first.response.text()).resolves.toBe('page');
	});

	it('stores nothing for a signed-in visitor', async () => {
		const run = await runWith('https://db.aynu.org/sources/x', {
			cookie: 'better-auth.session_token=abc'
		});
		expect(run.resolved).toBe(1);
		expect(run.cache.store.size).toBe(0);
		expect(run.response.headers.get('cache-control')).toBeNull();
	});

	it('stores nothing for the archive', async () => {
		const run = await runWith('https://db.aynu.org/archive/work/x/p/22');
		expect(run.cache.store.size).toBe(0);
	});

	it('stores nothing when the page did not render', async () => {
		const run = await runWith('https://db.aynu.org/sources/x', { status: 404 });
		expect(run.resolved).toBe(1);
		expect(run.cache.store.size).toBe(0);
	});

	it('passes through untouched where the platform has no cache', async () => {
		const event = {
			request: get('https://db.aynu.org/sources/x'),
			url: new URL('https://db.aynu.org/sources/x'),
			platform: undefined
		} as never;
		const response = await handleEdgeCache({
			event,
			resolve: async () => new Response('page', { status: 200 })
		} as never);
		expect(response.headers.get('cache-control')).toBeNull();
	});
});

describe('the cache key', () => {
	const keyOf = async (url: string, headers?: Record<string, string>) => {
		const store = new Map<string, Response>();
		const waited: Promise<unknown>[] = [];
		await handleEdgeCache({
			event: {
				request: new Request(url, { method: 'GET', headers }),
				url: new URL(url),
				platform: {
					caches: {
						default: {
							match: async (key: Request) => store.get(key.url)?.clone(),
							put: async (key: Request, response: Response) => void store.set(key.url, response)
						}
					},
					ctx: { waitUntil: (p: Promise<unknown>) => waited.push(p) }
				}
			},
			resolve: async () => new Response('page', { status: 200 })
		} as never);
		await Promise.all(waited);
		return [...store.keys()];
	};

	it('keys on the URL alone, since the path is what fixes the language', async () => {
		await expect(keyOf('https://db.aynu.org/ja/sources/x')).resolves.toEqual([
			'https://db.aynu.org/ja/sources/x'
		]);
	});

	it('shares one entry across visitors whose Accept-Language differs', async () => {
		// Every URL matches one of paraglide's urlPatterns and `en` is the unprefixed
		// one, so `url` resolves the locale before `preferredLanguage` is reached and
		// /sources/x is English for all of them. Splitting on the header would shard
		// the cache per browser and never hit.
		const en = await keyOf('https://db.aynu.org/sources/x', { 'accept-language': 'en-US,en' });
		const ja = await keyOf('https://db.aynu.org/sources/x', { 'accept-language': 'ja-JP,ja' });
		expect(en).toEqual(ja);
	});

	it('shares one entry across visitors whose locale cookie differs', async () => {
		const a = await keyOf('https://db.aynu.org/sources/x', { cookie: 'PARAGLIDE_LOCALE=ja' });
		const b = await keyOf('https://db.aynu.org/sources/x', { cookie: 'PARAGLIDE_LOCALE=ru' });
		expect(a).toEqual(b);
	});

	it('keeps query strings apart', async () => {
		const book = await keyOf('https://db.aynu.org/sources?types=book');
		const article = await keyOf('https://db.aynu.org/sources?types=article');
		expect(book).not.toEqual(article);
	});
});
