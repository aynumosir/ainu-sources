import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getPersonBySlug } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params }) => {
	const r = await getPersonBySlug(params.slug);
	if (!r) error(404, 'Person not found');
	return { person: r.person, sources: r.sources };
};
