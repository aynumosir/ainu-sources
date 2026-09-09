export const SITEMAP_LOGICAL_ENTRY_LIMIT = 2_000;
export const SITEMAP_URL_LIMIT = 50_000;
export const SITEMAP_BYTE_LIMIT = 50 * 1024 * 1024;

export interface SourceSitemapShard {
	id: string;
	path: string;
	start?: string;
	end?: string;
}

const sourceShard = (id: string, start?: string, end?: string): SourceSitemapShard => ({
	id,
	path: `/sitemaps/sources/${id}.xml`,
	start,
	end
});

/**
 * Half-open slug ranges cover SQLite's binary text order without overlap.
 * Narrow year-prefix ranges keep dense bibliographic periods below the row cap.
 */
export const sourceSitemapShards = [
	sourceShard('before-17', undefined, '17'),
	sourceShard('17', '17', '18'),
	sourceShard('18', '18', '19'),
	...Array.from({ length: 10 }, (_, offset) => {
		const yearPrefix = 190 + offset;
		const end = yearPrefix === 199 ? '20' : String(yearPrefix + 1);
		const start = yearPrefix === 190 ? '19' : String(yearPrefix);
		return sourceShard(String(yearPrefix), start, end);
	}),
	sourceShard('200', '20', '201'),
	sourceShard('201', '201', '202'),
	sourceShard('202', '202', '203'),
	sourceShard('numeric-rest', '203', 'a'),
	sourceShard('a-m', 'a', 'n'),
	sourceShard('n', 'n', 'o'),
	sourceShard('o-plus', 'o')
] as const satisfies readonly SourceSitemapShard[];

export type EntitySitemapKind = 'people' | 'places' | 'institutions';

export interface EntitySitemapChild {
	kind: EntitySitemapKind;
	path: string;
	detailPath: `/${EntitySitemapKind}`;
}

export const entitySitemapChildren = [
	{ kind: 'people', path: '/sitemaps/entities/people.xml', detailPath: '/people' },
	{ kind: 'places', path: '/sitemaps/entities/places.xml', detailPath: '/places' },
	{
		kind: 'institutions',
		path: '/sitemaps/entities/institutions.xml',
		detailPath: '/institutions'
	}
] as const satisfies readonly EntitySitemapChild[];

export const sitemapChildPaths = [
	'/sitemaps/pages.xml',
	...sourceSitemapShards.map((shard) => shard.path),
	...entitySitemapChildren.map((child) => child.path)
] as const;

export function findSourceSitemapShard(id: string): SourceSitemapShard | undefined {
	return sourceSitemapShards.find((shard) => shard.id === id);
}

export function findEntitySitemapChild(kind: string): EntitySitemapChild | undefined {
	return entitySitemapChildren.find((child) => child.kind === kind);
}
