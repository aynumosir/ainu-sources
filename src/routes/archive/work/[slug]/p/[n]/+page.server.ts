import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { loadArchiveWork, loadArchiveWorkPersons } from '$lib/archive/work-data.server';
import { db } from '$lib/server/db';
import { revisionOcrCoverage } from '$lib/server/db/schema';
import { eq, sql } from 'drizzle-orm';
import { loadPageFolios, loadTextCoverage } from '$lib/server/archive/work-text';

export const load: PageServerLoad = async ({ parent, params }) => {
	const layout = await parent();
	if (!layout.principal) return { accessDenied: true, work: null, persons: [] };
	if (!archiveRoleAtLeast(layout.principal.role, 'archive_reader')) error(403, 'archive reader role required');
	const requestedPage = parsePage(params.n);
	if (requestedPage === null) error(404, 'page not found');
	try {
		const [loadedWork, persons] = await Promise.all([
			loadArchiveWork(params.slug, layout.principal, requestedPage),
			loadArchiveWorkPersons(params.slug)
		]);
		// Both need the revision id, so neither can join the batch above — but they do
		// not need each other. Awaiting them in turn spent a whole database round trip
		// waiting, and on these pages nearly all of the time is round trips: measured
		// on production, a request spends about 4% of its wall clock on CPU.
		const work =
			loadedWork && !loadedWork.unavailable
				? await (async () => {
						const [ocr, folios] = await Promise.all([
							loadTextCoverage(loadedWork.revision.id),
							loadPageFolios(loadedWork.revision.id)
						]);
						return { ...loadedWork, ocr, folios };
					})()
				: loadedWork;
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
