import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getSourceBySlug, getRevisions } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params }) => {
	const source = await getSourceBySlug(params.slug);
	if (!source) error(404, 'Source not found');
	const revisions = await getRevisions(source.id);
	return {
		source: { slug: source.slug, title: source.title },
		revisions: revisions.map((r) => ({
			id: r.id,
			action: r.action,
			userName: r.userName,
			summary: r.summary,
			createdAt: r.createdAt
		}))
	};
};
