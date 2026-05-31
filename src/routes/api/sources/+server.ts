/**
 * GET /api/sources — search / filter the textual-sources catalogue.
 *
 * Query params (all optional): q, category, type, region, language, script,
 * tag, person, sort, page, limit. Thin wrapper over `listSources()` (the same
 * query the /sources browse page uses), returning a compact row shape.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSources } from '$lib/server/queries';
import type { SourceFilters, SortKey } from '$lib/types';

const CORS = { 'access-control-allow-origin': '*' } as const;
const one = (v: string | null): string[] | undefined => (v ? [v] : undefined);

export const GET: RequestHandler = async ({ url }) => {
	const sp = url.searchParams;
	const filters: SourceFilters = {
		q: sp.get('q') ?? undefined,
		category: sp.get('category') ?? undefined,
		types: one(sp.get('type')),
		regions: one(sp.get('region')),
		languages: one(sp.get('language')),
		scripts: one(sp.get('script')),
		tag: sp.get('tag') ?? undefined,
		person: sp.get('person') ?? undefined,
		sort: (sp.get('sort') as SortKey) ?? undefined,
		page: sp.get('page') ? Number(sp.get('page')) : undefined,
		pageSize: Math.min(Math.max(Number(sp.get('limit') ?? 20) || 20, 1), 100)
	};

	const { items, total, page, pageSize, pageCount } = await listSources(filters);

	return json(
		{
			query: filters.q ?? '',
			total,
			page,
			pageSize,
			pageCount,
			results: items.map((s) => ({
				slug: s.slug,
				title: s.title,
				titleEn: s.titleEn,
				titleAin: s.titleAin,
				type: s.type,
				category: s.category,
				author: s.author,
				yearText: s.yearText,
				yearStart: s.yearStart,
				yearEnd: s.yearEnd,
				region: s.region,
				dialect: s.dialect,
				languages: s.languages,
				scripts: s.scripts,
				entryCount: s.entryCount,
				entryCountLabel: s.entryCountLabel,
				summary: s.summary
			}))
		},
		{ headers: CORS }
	);
};
