import type { PageServerLoad } from './$types';
import { getStats, listSources, getTimelineDensity } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	const [stats, recentResult, timeline] = await Promise.all([
		getStats(),
		listSources({ sort: 'updated', pageSize: 8 }),
		getTimelineDensity()
	]);
	return { stats, recent: recentResult.items, timeline };
};
