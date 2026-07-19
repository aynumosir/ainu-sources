import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { loadArchiveWork, loadArchiveWorkPersons } from '$lib/archive/work-data.server';

export const load: PageServerLoad = async ({ parent, params }) => {
	const layout = await parent();
	if (!layout.principal) return { accessDenied: true, work: null, persons: [] };
	if (!archiveRoleAtLeast(layout.principal.role, 'archive_reader')) error(403, 'archive reader role required');
	const requestedPage = parsePage(params.n);
	if (requestedPage === null) error(404, 'page not found');
	try {
		const [work, persons] = await Promise.all([
			loadArchiveWork(params.slug, layout.principal, requestedPage),
			loadArchiveWorkPersons(params.slug)
		]);
		return {
			accessDenied: false,
			work,
			persons
		};
	} catch (cause) {
		if (cause instanceof ArchiveHttpError) error(cause.status, cause.message);
		throw cause;
	}
};

function parsePage(value: string): number | null {
	if (!/^[1-9][0-9]*$/u.test(value)) return null;
	const page = Number(value);
	return Number.isSafeInteger(page) ? page : null;
}
