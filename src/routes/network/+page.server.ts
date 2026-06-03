import type { PageServerLoad } from './$types';
import { getCitationNetwork } from '$lib/server/network';

export const load: PageServerLoad = async () => {
	const network = await getCitationNetwork();
	return { network };
};
