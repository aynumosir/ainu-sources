/**
 * POST /api/archive/uploads/<id>/parts/sign — proxy a bounded batch of part
 * signing requests to the archive dataplane.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params, platform }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	const body = await readJsonObject(request);
	try {
		const response = await dataplane.multipartSignParts(getArchiveFetcher(platform?.env), principal.userId, {
			upload_id: params.id,
			...body
		});
		return json(await response.json(), { status: response.status });
	} catch (e) {
		throwArchiveError(e);
	}
};
