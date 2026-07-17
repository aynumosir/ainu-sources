/**
 * GET/HEAD /api/archive/revisions/<id>/content — stream a revision's blob
 * through the archive dataplane with byte-range and no-store headers.
 */
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { getRevisionForContent, reserveStreamQuota } from '$lib/server/archive/db';
import { recordArchiveEvent } from '$lib/server/archive/audit';
import { getArchiveFetcher } from '$lib/server/archive/dataplane';
import { buildRangeResponse, quotedSha256Etag } from '$lib/server/archive/range';
import { streamRevisionContent } from '$lib/server/archive/stream';

async function handle(event: Parameters<RequestHandler>[0], method: 'GET' | 'HEAD'): Promise<Response> {
	const principal = await archivePrincipal(event.request, 'archive_reader');
	try {
		const revision = await getRevisionForContent(db, event.params.id, principal);
		const range = buildRangeResponse(
			event.request.headers.get('range'),
			event.request.headers.get('if-range'),
			revision.bytes,
			quotedSha256Etag(revision.sha256 ?? '')
		);
		const bytes = range.status === 416 ? 0 : range.contentLength;
		await reserveStreamQuota(db, principal, revision.id, bytes);
		await recordArchiveEvent(db, {
			entityType: 'file_revision',
			entityId: revision.id,
			eventType: 'stream_opened',
			actor: principal.userId,
			details: { bytes, range: event.request.headers.get('range') ?? null }
		});
		return streamRevisionContent(getArchiveFetcher(event.platform?.env), principal.userId, event.request, revision, method);
	} catch (e) {
		throwArchiveError(e);
	}
}

export const GET: RequestHandler = (event) => handle(event, 'GET');
export const HEAD: RequestHandler = (event) => handle(event, 'HEAD');
