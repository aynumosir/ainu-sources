import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getSourceDetail } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params }) => {
	const detail = await getSourceDetail(params.slug);
	if (!detail) error(404, 'Source not found');
	return { detail };
};
