import type { PageServerLoad } from './$types';
import { listSources, computeFacets } from '$lib/server/queries';
import { parseFilters } from '$lib/filters';

export const load: PageServerLoad = async ({ url }) => {
	const filters = parseFilters(url.searchParams);
	const [result, facets] = await Promise.all([listSources(filters), computeFacets(filters)]);
	return { filters, result, facets };
};
