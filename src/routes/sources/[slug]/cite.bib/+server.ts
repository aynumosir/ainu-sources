import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getSourceDetail } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toBibtex } from '$lib/server/cite';

export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}/cite.bib`);
		error(404, 'Source not found');
	}

	const bibtex = toBibtex(buildCitation(detail, params.slug));
	return new Response(bibtex, {
		headers: {
			'content-type': 'text/x-bibtex; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.bib"`
		}
	});
};
