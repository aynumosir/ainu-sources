import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listPersonRoles } from '$lib/server/queries';
import { parsePeopleQuery, loadPeopleChunk } from '$lib/server/people-list';

export const load: PageServerLoad = async ({ url }) => {
	const query = parsePeopleQuery(url.searchParams);
	if (query === undefined) throw error(404);
	const [people, roles] = await Promise.all([loadPeopleChunk(query), listPersonRoles()]);
	return { people, roles, filters: { q: query.q, role: query.role, sort: query.sort } };
};
