import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SITE_ORIGIN } from '$lib/seo';
import {
	SITEMAP_LOGICAL_ENTRY_LIMIT,
	sitemapChildPaths,
	sourceSitemapShards
} from '$lib/server/sitemap-manifest';
import { GET as getIndex } from '../sitemap.xml/+server';
import { GET as getPages } from './pages.xml/+server';
import { GET as getSources } from './sources/[shard].xml/+server';
import { GET as getEntities } from './entities/[kind].xml/+server';
import { getSitemapEntities, getSitemapSources } from '$lib/server/queries';

vi.mock('$lib/server/queries', () => ({
	getSitemapSources: vi.fn(),
	getSitemapEntities: vi.fn()
}));

const sourceRows = vi.mocked(getSitemapSources);
const entityRows = vi.mocked(getSitemapEntities);
const event = (pathname: string, params: Record<string, string> = {}) =>
	({
		params,
		url: new URL(pathname, 'https://preview.example')
	}) as never;

describe('sitemap routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('publishes the shared child manifest from the production origin', async () => {
		const response = await getIndex(event('/sitemap.xml'));
		const xml = await response.text();
		expect(response.status).toBe(200);
		expect((xml.match(/<sitemap>/g) ?? []).length).toBe(sitemapChildPaths.length);
		for (const path of sitemapChildPaths) expect(xml).toContain(`${SITE_ORIGIN}${path}`);
	});

	it('publishes all static pages in every locale', async () => {
		const response = await getPages(event('/sitemaps/pages.xml'));
		const xml = await response.text();
		expect((xml.match(/<url>/g) ?? []).length).toBe(9 * 4);
		expect(xml).toContain(`${SITE_ORIGIN}/ja/about`);
		expect(xml).toContain(`${SITE_ORIGIN}/ru/about`);
		expect(xml).toContain(`${SITE_ORIGIN}/ain/about`);
	});

	it('queries the requested source shard and emits only its rows', async () => {
		sourceRows.mockResolvedValue([
			{ slug: '190-example', updatedAt: new Date('2026-09-01T00:00:00Z') }
		]);
		const response = await getSources(
			event('/sitemaps/sources/190.xml', { shard: '190' })
		);
		const xml = await response.text();
		expect(sourceRows).toHaveBeenCalledWith(
			sourceSitemapShards.find((shard) => shard.id === '190')
		);
		expect((xml.match(/<url>/g) ?? []).length).toBe(4);
		expect(xml).toContain(`${SITE_ORIGIN}/sources/190-example`);
		expect(xml).not.toContain('preview.example');
	});

	it('rejects unknown source and entity children before querying', async () => {
		await expect(
			getSources(event('/sitemaps/sources/missing.xml', { shard: 'missing' }))
		).rejects.toMatchObject({ status: 404 });
		await expect(
			getEntities(event('/sitemaps/entities/tags.xml', { kind: 'tags' }))
		).rejects.toMatchObject({ status: 404 });
		expect(sourceRows).not.toHaveBeenCalled();
		expect(entityRows).not.toHaveBeenCalled();
	});

	it('returns an uncached 503 when a source shard exceeds its logical row cap', async () => {
		sourceRows.mockResolvedValue(
			Array.from({ length: SITEMAP_LOGICAL_ENTRY_LIMIT + 1 }, (_, index) => ({
				slug: `190-${index}`,
				updatedAt: new Date('2026-09-01T00:00:00Z')
			}))
		);
		const response = await getSources(
			event('/sitemaps/sources/190.xml', { shard: '190' })
		);
		expect(response.status).toBe(503);
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('x-robots-tag')).toBe('noindex');
	});

	it('queries one active entity kind and emits the matching detail path', async () => {
		entityRows.mockResolvedValue([{ slug: 'example-place' }]);
		const response = await getEntities(
			event('/sitemaps/entities/places.xml', { kind: 'places' })
		);
		const xml = await response.text();
		expect(entityRows).toHaveBeenCalledWith('places');
		expect((xml.match(/<url>/g) ?? []).length).toBe(4);
		expect(xml).toContain(`${SITE_ORIGIN}/places/example-place`);
	});

	it('redirects query variants before any database query', async () => {
		const response = await getSources(
			event('/sitemaps/sources/190.xml?cache-bust=1', { shard: '190' })
		);
		expect(response.status).toBe(308);
		expect(response.headers.get('location')).toBe('/sitemaps/sources/190.xml');
		expect(sourceRows).not.toHaveBeenCalled();
	});
});
