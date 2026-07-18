import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: PageServerLoad = async ({ request, parent }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');
	const layout = await parent();
	return { accessDenied: false, principal, usage: layout.usage };
};
