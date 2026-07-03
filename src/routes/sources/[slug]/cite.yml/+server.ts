import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getSourceDetail } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toHayagriva } from '$lib/server/cite';

// Hayagriva YAML — the bibliography format used by Typst (typst.app).
export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}/cite.yml`);
		error(404, 'Source not found');
	}

	const yaml = toHayagriva(buildCitation(detail, params.slug));
	return new Response(yaml, {
		headers: {
			'content-type': 'application/yaml; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.yml"`
		}
	});
};
