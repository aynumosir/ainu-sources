import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeContent } from '$lib/server/archive/gateway';
import { archivePrincipal, archiveRouteDb, throwArchiveError } from '$lib/server/archive/route';
import { listPageEditLog } from '$lib/server/archive/workspace';

export const GET: RequestHandler = async ({ request, params, url, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archivePrincipal(request, 'archive_reader', db);
	try {
		await authorizeContent(db, {
			principal,
			revisionId: params.id,
			useKind: principal.authn === 'mcp_assertion' ? 'mcp_text' : 'text',
			requestedBytes: 0,
			rateUnits: 1
		});
		return json(await listPageEditLog(db, params.id, Number(params.page), { cursor: url.searchParams.get('cursor') }));
	} catch (e) {
		throwArchiveError(e);
	}
};
