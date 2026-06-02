import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSourceDetail } from '$lib/server/queries';
import { buildCitation, toRIS } from '$lib/server/cite';

// RIS — the import format for EndNote, Zotero, Mendeley, RefWorks, etc.
export const GET: RequestHandler = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');

	const ris = toRIS(buildCitation(detail, params.slug));
	return new Response(ris, {
		headers: {
			'content-type': 'application/x-research-info-systems; charset=utf-8',
			'content-disposition': `inline; filename="${params.slug}.ris"`
		}
	});
};
