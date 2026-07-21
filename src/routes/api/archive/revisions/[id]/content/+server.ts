/**
 * GET/HEAD /api/archive/revisions/<id>/content — stream a revision's blob
 * through the archive dataplane with byte-range and no-store headers.
 */
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import { authorizeContent } from '$lib/server/archive/gateway';
import { getArchiveFetcher } from '$lib/server/archive/dataplane';
import { streamRevisionContent } from '$lib/server/archive/stream';

async function handle(event: Parameters<RequestHandler>[0], method: 'GET' | 'HEAD'): Promise<Response> {
	const principal = await archivePrincipal(event.request, 'archive_reader');
	try {
		const access = await authorizeContent(db, {
			principal,
			revisionId: event.params.id,
			useKind: 'original',
			rangeHeader: event.request.headers.get('range'),
			ifRangeHeader: event.request.headers.get('if-range')
		});
		return streamRevisionContent(
			getArchiveFetcher(event.platform?.env),
			principal.userId,
			event.request,
			access.revision,
			method,
			access.cachePolicy
		);
	} catch (e) {
		throwArchiveError(e);
	}
}

export const GET: RequestHandler = (event) => handle(event, 'GET');
export const HEAD: RequestHandler = (event) => handle(event, 'HEAD');
