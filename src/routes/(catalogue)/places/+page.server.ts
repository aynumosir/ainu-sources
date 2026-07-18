import type { PageServerLoad } from './$types';
import { listPlaces } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	return { places: await listPlaces() };
};
