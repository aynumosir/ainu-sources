/**
 * GET/DELETE /api/archive/uploads/<id> — poll upload state or abort an upload
 * owned by the contributor.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { abortUploadSession, getUploadSession, reconcileUploadFinalization } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, params, platform, locals }) => {
	const db = routeDb(locals);
	const principal = await archivePrincipal(request, 'archive_contributor', db);
	try {
		await getUploadSession(db, params.id, principal);
		const response = await dataplane.finalizeResults(getArchiveFetcher(platform?.env), principal.userId, params.id);
		const finalize = response.status === 404 ? null : await safeJson(response);
		const upload = await reconcileUploadFinalization(db, params.id, principal, {
			status: response.status,
			body: finalize
		});
		return json({ upload, finalize });
	} catch (e) {
		throwArchiveError(e);
	}
};

export const DELETE: RequestHandler = async ({ request, params, platform, locals }) => {
	const db = routeDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_contributor', db);
	try {
		await dataplane.multipartAbort(getArchiveFetcher(platform?.env), principal.userId, { upload_id: params.id });
		return json({ upload: await abortUploadSession(db, params.id, principal) });
	} catch (e) {
		throwArchiveError(e);
	}
};

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
