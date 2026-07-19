import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeContent } from '$lib/server/archive/gateway';
import {
	archiveMutationPrincipal,
	archiveRouteDb,
	readJsonObject,
	throwArchiveError
} from '$lib/server/archive/route';
import { approvePageEdit } from '$lib/server/archive/workspace';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_reviewer', db);
	try {
		await authorizeContent(db, { principal, revisionId: params.id, useKind: 'text', requestedBytes: 0, rateUnits: 1 });
		const body = await readJsonObject(request);
		if (typeof body.edit_id !== 'string' || !body.edit_id) throw error(400, 'edit_id is required');
		return json(await approvePageEdit(db, params.id, Number(params.page), body.edit_id, principal));
	} catch (e) {
		throwArchiveError(e);
	}
};
