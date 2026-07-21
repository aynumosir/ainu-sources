import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeContent } from '$lib/server/archive/gateway';
import { archiveMutationPrincipal, archiveRouteDb, throwArchiveError } from '$lib/server/archive/route';
import { revertPageToMachine } from '$lib/server/archive/workspace';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_contributor', db);
	try {
		await authorizeContent(db, { principal, revisionId: params.id, useKind: 'text', requestedBytes: 0, rateUnits: 1 });
		return json(await revertPageToMachine(db, params.id, Number(params.page), principal));
	} catch (e) {
		throwArchiveError(e);
	}
};
