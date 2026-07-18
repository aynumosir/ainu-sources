import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getInstitutionBySlug } from '$lib/server/queries';

export const load: PageServerLoad = async ({ params }) => {
	const r = await getInstitutionBySlug(params.slug);
	if (!r) error(404, 'Institution not found');
	return { institution: r.institution, sources: r.sources };
};
