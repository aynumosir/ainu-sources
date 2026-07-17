/**
 * GET/DELETE /api/archive/uploads/<id> — poll upload state or abort an upload
 * owned by the contributor.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { abortUploadSession, getUploadSession } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, params, platform }) => {
	const principal = await archivePrincipal(request, 'archive_contributor');
	try {
		const upload = await getUploadSession(db, params.id, principal);
		const finalize = await dataplane.blobsFinalize(getArchiveFetcher(platform?.env), principal.userId, {
			upload_id: params.id,
			poll: true
		});
		return json({ upload, finalize: finalize.headers.get('content-type')?.includes('json') ? await finalize.json() : null });
	} catch (e) {
		throwArchiveError(e);
	}
};

export const DELETE: RequestHandler = async ({ request, params, platform }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	try {
		await dataplane.multipartAbort(getArchiveFetcher(platform?.env), principal.userId, { upload_id: params.id });
		return json({ upload: await abortUploadSession(db, params.id, principal) });
	} catch (e) {
		throwArchiveError(e);
	}
};
