import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: PageServerLoad = async ({ request }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, title: 'Admin' };
	if (!archiveRoleAtLeast(principal.role, 'archive_admin')) error(403, 'archive admin role required');
	return { accessDenied: false, title: 'Admin' };
};
