import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { loadArchiveWork } from '$lib/archive/work-data.server';

export const load: PageServerLoad = async ({ parent, params }) => {
	const layout = await parent();
	if (!layout.principal) return { accessDenied: true, work: null };
	if (!archiveRoleAtLeast(layout.principal.role, 'archive_reader')) error(403, 'archive reader role required');
	try {
		return { accessDenied: false, work: await loadArchiveWork(params.slug, layout.principal, null) };
	} catch (cause) {
		if (cause instanceof ArchiveHttpError) error(cause.status, cause.message);
		throw cause;
	}
};
