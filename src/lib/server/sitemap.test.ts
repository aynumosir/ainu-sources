import { describe, expect, it } from 'vitest';
import { SITE_ORIGIN, hreflangAlternates } from '$lib/seo';
import {
	SitemapLimitError,
	assertSitemapLimits,
	sitemapIndexXml,
	sitemapQueryRedirect,
	urlsetResponse,
	urlsetXml
} from './sitemap';
import {
	entitySitemapChildren,
	sitemapChildPaths,
	sourceSitemapShards
} from './sitemap-manifest';

const occurrences = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

describe('sitemap manifest', () => {
	it('covers the complete slug order with adjacent half-open ranges', () => {
		expect(sourceSitemapShards[0].start).toBeUndefined();
		expect(sourceSitemapShards.at(-1)?.end).toBeUndefined();
		for (let index = 1; index < sourceSitemapShards.length; index += 1) {
			expect(sourceSitemapShards[index - 1].end).toBe(sourceSitemapShards[index].start);
		}
	});

	it('gives every child one canonical path', () => {
		expect(new Set(sitemapChildPaths).size).toBe(sitemapChildPaths.length);
		expect(sitemapChildPaths).toContain('/sitemaps/pages.xml');
		for (const child of [...sourceSitemapShards, ...entitySitemapChildren]) {
			expect(sitemapChildPaths).toContain(child.path);
		}
	});
});

describe('sitemap XML', () => {
	it('emits every locale URL with a complete reciprocal alternate cluster', () => {
		const entry = {
			path: '/sources/a&b',
			lastmod: '2026-09-01T12:00:00.000Z',
			changefreq: 'monthly',
			priority: 0.8
		};
		const xml = urlsetXml(SITE_ORIGIN, [entry]);
		const alternates = hreflangAlternates(SITE_ORIGIN, entry.path);

		expect(occurrences(xml, /<url>/g)).toBe(alternates.length - 1);
		expect(occurrences(xml, /<xhtml:link /g)).toBe(
			alternates.length * (alternates.length - 1)
		);
		for (const alternate of alternates) {
			expect(occurrences(xml, new RegExp(`hreflang="${alternate.hreflang}"`, 'g'))).toBe(
				alternates.length - 1
			);
			expect(xml).toContain(alternate.href.replace('&', '&amp;'));
		}
		expect(xml).toContain('<lastmod>2026-09-01T12:00:00.000Z</lastmod>');
	});

	it('rejects output above either protocol ceiling', () => {
		const entries = [{ path: '/one' }, { path: '/two' }];
		expect(() => assertSitemapLimits(SITE_ORIGIN, entries, { maxUrls: 7 })).toThrow(
			SitemapLimitError
		);
		expect(() => assertSitemapLimits(SITE_ORIGIN, entries, { maxBytes: 100 })).toThrow(
			SitemapLimitError
		);
	});

	it('streams the same preflighted XML with explicit cache policy', async () => {
		const entries = [{ path: '/sources/example' }];
		const response = urlsetResponse(SITE_ORIGIN, entries);
		expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
		expect(response.headers.get('cache-control')).toBe(
			'public, max-age=3600, stale-while-revalidate=86400'
		);
		expect(await response.text()).toBe(urlsetXml(SITE_ORIGIN, entries));
	});

	it('builds an index without synthetic modification dates or request-host URLs', () => {
		const xml = sitemapIndexXml(
			SITE_ORIGIN,
			sitemapChildPaths.map((path) => ({ path }))
		);
		expect(occurrences(xml, /<sitemap>/g)).toBe(sitemapChildPaths.length);
		expect(xml).not.toContain('<lastmod>');
		expect(xml).not.toContain('preview.example');
		for (const path of sitemapChildPaths) expect(xml).toContain(`${SITE_ORIGIN}${path}`);
	});
});

describe('sitemap request canonicalization', () => {
	it('redirects query variants to the same path before route work', () => {
		const response = sitemapQueryRedirect(
			new URL('https://preview.example/sitemaps/sources/190.xml?cache-bust=1')
		);
		expect(response?.status).toBe(308);
		expect(response?.headers.get('location')).toBe('/sitemaps/sources/190.xml');
	});

	it('allows the canonical query-free request', () => {
		expect(
			sitemapQueryRedirect(new URL('https://preview.example/sitemaps/sources/190.xml'))
		).toBeUndefined();
	});
});
