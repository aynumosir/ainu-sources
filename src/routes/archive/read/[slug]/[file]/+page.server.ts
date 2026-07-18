import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: PageServerLoad = async ({ request, params }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) return { accessDenied: true, title: 'Reader', slug: params.slug, file: params.file };
	if (!archiveRoleAtLeast(principal.role, 'archive_reader')) error(403, 'archive reader role required');
	return { accessDenied: false, title: 'Reader', slug: params.slug, file: params.file };
};
