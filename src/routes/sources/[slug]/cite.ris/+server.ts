import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { getSourceDetail } from '$lib/server/queries';
import { resolveSlug } from '$lib/server/resolve-slug';
import { buildCitation, toRIS } from '$lib/server/cite';

// RIS — the import format for EndNote, Zotero, Mendeley, RefWorks, etc.
export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) {
		const renamed = await resolveSlug(db, params.slug);
		if (renamed) redirect(301, `/sources/${renamed}/cite.ris`);
		error(404, 'Source not found');
	}

	const ris = toRIS(buildCitation(detail, params.slug));
	return new Response(ris, {
		headers: {
			'content-type': 'application/x-research-info-systems; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.ris"`
		}
	});
};
