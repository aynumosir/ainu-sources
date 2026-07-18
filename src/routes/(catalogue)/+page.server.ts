import type { PageServerLoad } from './$types';
import { getStats, listSources, getTimeline } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	const [stats, recentResult, timeline] = await Promise.all([
		getStats(),
		listSources({ sort: 'updated', pageSize: 8 }),
		getTimeline()
	]);
	return { stats, recent: recentResult.items, timeline };
};
