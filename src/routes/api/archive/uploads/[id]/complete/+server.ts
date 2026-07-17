/**
 * POST /api/archive/uploads/<id>/complete — mark a multipart upload complete
 * and return a pollable 202 response while finalization continues.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { completeUploadSession } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params, platform }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	const body = await readJsonObject(request);
	try {
		await dataplane.multipartComplete(getArchiveFetcher(platform?.env), principal.userId, {
			upload_id: params.id,
			...body
		});
		return json({ upload: await completeUploadSession(db, params.id, principal), poll: `/api/archive/uploads/${params.id}` }, { status: 202 });
	} catch (e) {
		throwArchiveError(e);
	}
};
