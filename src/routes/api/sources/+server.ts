/**
 * GET /api/sources — search / filter the textual-sources catalogue.
 *
 * Query params (all optional): q, category, type, region, language, script,
 * tag, person, sort, page, limit. Thin wrapper over `listSources()` (the same
 * query the /sources browse page uses), returning a compact row shape.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listSources, createSource, getSourceDetail, type SourceInput } from '$lib/server/queries';
import type { SourceFilters, SortKey } from '$lib/types';
import {
	requireWriteToken,
	pickSourceInput,
	pickUser,
	revisionSummaryOf,
	assertRequiredFields
} from '$lib/server/write-api';

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

/**
 * POST /api/sources — create a new source. Authorized by the SOURCES_WRITE_TOKEN
 * bearer secret (see write-api.ts), not a login session. Body is a JSON
 * SourceInput (title + type + category required) plus optional `user`
 * ({ id?, name? }) attribution and `revisionSummary`. Reuses createSource() so
 * the source flows through the merge engine exactly as the UI does; the
 * `MergeResult` is returned so the caller can see a held/conflict outcome.
 */
export const POST: RequestHandler = async ({ request }) => {
	requireWriteToken(request);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'expected a JSON object body');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'expected a JSON object body');
	const b = body as Record<string, unknown>;
	const input = pickSourceInput(b);
	if (input.category === undefined) input.category = 'primary';
	assertRequiredFields(input);
	const { slug, result } = await createSource(input as SourceInput, pickUser(b), revisionSummaryOf(b));
	if (!slug) return json({ result }, { status: 422 });
	return json({ slug, result, source: await getSourceDetail(slug) }, { status: 201 });
};
