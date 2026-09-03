import type { PageServerLoad } from './$types';
import { error, redirect } from '@sveltejs/kit';
import { getPersonBySlug } from '$lib/server/queries';
import { resolvePersonSlug } from '$lib/server/resolve-slug';
import { db } from '$lib/server/db';

export const load: PageServerLoad = async ({ params }) => {
	const r = await getPersonBySlug(params.slug);
	if (!r) {
		const current = await resolvePersonSlug(db, params.slug);
		if (current) redirect(301, `/people/${current}`);
		error(404, 'Person not found');
	}
	return { person: r.person, sources: r.sources, areas: r.areas };
};
