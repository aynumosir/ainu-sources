/**
 * POST /api/archive/uploads — create an upload session and its logical file
 * slot in one database transaction, then begin the multipart upload in the
 * archive dataplane.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { createUploadSession } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, platform }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	const body = await readJsonObject(request);
	try {
		const created = await createUploadSession(db, principal, {
			sourceSlug: String(body.source_slug ?? body.sourceSlug ?? ''),
			role: String(body.role ?? ''),
			checkoutRepo: typeof body.checkout_repo === 'string' ? body.checkout_repo : null,
			checkoutPath: typeof body.checkout_path === 'string' ? body.checkout_path : null,
			bytes: Number(body.size ?? body.bytes),
			sha256: String(body.sha256 ?? ''),
			declaredMediaType: String(body.declared_media_type ?? body.declaredMediaType ?? '')
		});
		const response = await dataplane.multipartCreate(getArchiveFetcher(platform?.env), principal.userId, {
			upload_id: created.session.id,
			staging_key: created.session.stagingKey,
			sha256: created.session.expectedSha256,
			bytes: created.session.expectedBytes,
			media_type: created.session.declaredMediaType
		});
		const dataplaneBody = response.headers.get('content-type')?.includes('json') ? await response.json() : null;
		return json({ upload: created.session, dataplane: dataplaneBody }, { status: 201 });
	} catch (e) {
		throwArchiveError(e);
	}
};
