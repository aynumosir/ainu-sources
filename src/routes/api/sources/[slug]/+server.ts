/**
 * GET /api/sources/<slug> — full detail for one source: the source record plus
 * its linked persons, places, institutions, digital links, relations and tags.
 * Reuses `getSourceDetail()` — the same loader the /sources/[slug] page uses.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail, updateSource } from '$lib/server/queries';
import {
	requireWriteToken,
	pickSourceInput,
	pickUser,
	revisionSummaryOf,
	detailToInput,
	assertRequiredFields
} from '$lib/server/write-api';

const CORS = { 'access-control-allow-origin': '*' } as const;

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) throw error(404, `no source with slug ${params.slug}`);
	return json(detail, { headers: CORS });
};

/**
 * PATCH /api/sources/<slug> — update an existing source. Authorized by the
 * SOURCES_WRITE_TOKEN bearer secret (see write-api.ts). Partial: only the
 * SourceInput fields present in the body are changed; everything else (incl.
 * links/tags if omitted) is carried over from the current record, then routed
 * through the merge engine via updateSource(); the `MergeResult` is returned so
 * the caller can see a held/conflict outcome.
 */
export const PATCH: RequestHandler = async ({ request, params }) => {
	requireWriteToken(request);
	const detail = await getSourceDetail(params.slug);
	if (!detail) throw error(404, `no source with slug ${params.slug}`);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'expected a JSON object body');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'expected a JSON object body');
	const b = body as Record<string, unknown>;
	const merged = { ...detailToInput(detail), ...pickSourceInput(b) };
	assertRequiredFields(merged);
	const { slug, result } = await updateSource(detail.source.id, merged, pickUser(b), revisionSummaryOf(b));
	return json({ slug, result, source: await getSourceDetail(slug) });
};
