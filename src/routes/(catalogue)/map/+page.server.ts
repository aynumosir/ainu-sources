import type { PageServerLoad } from './$types';
import { getMapPlaces } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	return { places: await getMapPlaces() };
};
