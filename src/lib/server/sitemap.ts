import { hreflangAlternates } from '$lib/seo';
import { SITEMAP_BYTE_LIMIT, SITEMAP_URL_LIMIT } from './sitemap-manifest';

export interface SitemapEntry {
	/** Bare locale-free path, such as `/sources/kindaichi-1931`. */
	path: string;
	lastmod?: Date | string | null;
	changefreq?: string;
	priority?: number;
}

export interface SitemapLimits {
	maxUrls?: number;
	maxBytes?: number;
}

export interface SitemapMetrics {
	urls: number;
	bytes: number;
}

const URLSET_HEADER = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
`;
const URLSET_FOOTER = '</urlset>\n';
const XML_CACHE_CONTROL = 'public, max-age=3600, stale-while-revalidate=86400';
const encoder = new TextEncoder();

const esc = (value: string) =>
	value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');

function* urlNodes(origin: string, entries: readonly SitemapEntry[]): Generator<string> {
	for (const entry of entries) {
		const alternates = hreflangAlternates(origin, entry.path);
		const localizedAlternates = alternates.filter((alternate) => alternate.hreflang !== 'x-default');
		const links = alternates
			.map(
				(alternate) =>
					`\n\t\t<xhtml:link rel="alternate" hreflang="${esc(alternate.hreflang)}" href="${esc(alternate.href)}" />`
			)
			.join('');
		const lastmod = entry.lastmod
			? `\n\t\t<lastmod>${new Date(entry.lastmod).toISOString()}</lastmod>`
			: '';
		const changefreq = entry.changefreq
			? `\n\t\t<changefreq>${esc(entry.changefreq)}</changefreq>`
			: '';
		const priority =
			entry.priority != null ? `\n\t\t<priority>${entry.priority.toFixed(1)}</priority>` : '';

		for (const alternate of localizedAlternates) {
			yield `\t<url>\n\t\t<loc>${esc(alternate.href)}</loc>${links}${lastmod}${changefreq}${priority}\n\t</url>\n`;
		}
	}
}

export function sitemapMetrics(origin: string, entries: readonly SitemapEntry[]): SitemapMetrics {
	let urls = 0;
	let bytes = encoder.encode(URLSET_HEADER).byteLength + encoder.encode(URLSET_FOOTER).byteLength;
	for (const node of urlNodes(origin, entries)) {
		urls += 1;
		bytes += encoder.encode(node).byteLength;
	}
	return { urls, bytes };
}

export class EmptySitemapError extends Error {
	constructor() {
		super('Sitemap has no URLs');
	}
}

export class SitemapLimitError extends Error {
	constructor(
		readonly metrics: SitemapMetrics,
		readonly limits: Required<SitemapLimits>
	) {
		super(`Sitemap exceeds its configured limits (${metrics.urls} URLs, ${metrics.bytes} bytes)`);
	}
}

export function assertSitemapLimits(
	origin: string,
	entries: readonly SitemapEntry[],
	limits: SitemapLimits = {}
): SitemapMetrics {
	const resolved = {
		maxUrls: limits.maxUrls ?? SITEMAP_URL_LIMIT,
		maxBytes: limits.maxBytes ?? SITEMAP_BYTE_LIMIT
	};
	const metrics = sitemapMetrics(origin, entries);
	if (metrics.urls === 0) throw new EmptySitemapError();
	if (metrics.urls > resolved.maxUrls || metrics.bytes > resolved.maxBytes) {
		throw new SitemapLimitError(metrics, resolved);
	}
	return metrics;
}

/** Collect a sitemap for small static responses and tests. */
export function urlsetXml(
	origin: string,
	entries: readonly SitemapEntry[],
	limits?: SitemapLimits
): string {
	assertSitemapLimits(origin, entries, limits);
	return URLSET_HEADER + [...urlNodes(origin, entries)].join('') + URLSET_FOOTER;
}

function* urlsetChunks(origin: string, entries: readonly SitemapEntry[]): Generator<string> {
	yield URLSET_HEADER;
	yield* urlNodes(origin, entries);
	yield URLSET_FOOTER;
}

/** Stream a preflighted sitemap so Worker memory stays independent of XML size. */
export function urlsetResponse(origin: string, entries: readonly SitemapEntry[]): Response {
	assertSitemapLimits(origin, entries);
	const chunks = urlsetChunks(origin, entries);
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			const next = chunks.next();
			if (next.done) controller.close();
			else controller.enqueue(encoder.encode(next.value));
		}
	});
	return xmlResponse(body);
}

/** A sitemap index pointing crawlers at the bounded child sitemaps. */
export function sitemapIndexXml(origin: string, children: readonly { path: string }[]): string {
	const nodes = children.map(
		(child) =>
			`\t<sitemap>\n\t\t<loc>${esc(new URL(child.path, origin).href)}</loc>\n\t</sitemap>`
	);
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${nodes.join('\n')}
</sitemapindex>
`;
}

export const xmlResponse = (body: BodyInit) =>
	new Response(body, {
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
			'Cache-Control': XML_CACHE_CONTROL
		}
	});

/** Sitemap responses have one canonical cache key and never use query parameters. */
export function sitemapQueryRedirect(url: URL): Response | undefined {
	if (!url.search) return undefined;
	return new Response(null, { status: 308, headers: { Location: url.pathname } });
}

export const sitemapCapacityResponse = () => sitemapUnavailableResponse('Sitemap capacity exceeded');
export const emptySitemapResponse = () => sitemapUnavailableResponse('Sitemap has no URLs');

const sitemapUnavailableResponse = (message: string) =>
	new Response(message, {
		status: 503,
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'no-store',
			'X-Robots-Tag': 'noindex'
		}
	});
