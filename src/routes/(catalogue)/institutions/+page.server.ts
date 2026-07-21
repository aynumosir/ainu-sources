import type { PageServerLoad } from './$types';
import { listInstitutions } from '$lib/server/queries';

export const load: PageServerLoad = async () => {
	return { institutions: await listInstitutions() };
};
