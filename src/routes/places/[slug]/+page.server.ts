import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getPlaceBySlug } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params }) => {
	const r = await getPlaceBySlug(params.slug);
	if (!r) error(404, 'Place not found');
	return { place: r.place, sources: r.sources };
};
