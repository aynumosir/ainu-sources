import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';
import { buildCitation, toHayagriva } from '$lib/server/cite';

// Hayagriva YAML — the bibliography format used by Typst (typst.app).
export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const yaml = toHayagriva(buildCitation(detail, params.slug));
	return new Response(yaml, {
		headers: {
			'content-type': 'application/yaml; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.yml"`
		}
	});
};
