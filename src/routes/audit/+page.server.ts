import type { PageServerLoad } from './$types';
import { getContentAudit } from '$lib/server/queries';

// Public, read-only content-quality audit of the catalogue. Surfaces missing
// metadata, likely duplicates, and unverified author/Wikidata links so anyone
// can see what needs cleanup. (Batch fixes are a separate, admin-gated layer.)
export const load: PageServerLoad = async () => {
	return { audit: await getContentAudit() };
};
