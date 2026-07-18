import type { PageServerLoad } from './$types';
import { getTimeline } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	return { points: await getTimeline() };
};
