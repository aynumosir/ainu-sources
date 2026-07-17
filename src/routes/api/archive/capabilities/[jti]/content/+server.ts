/**
 * GET/HEAD /api/archive/capabilities/<jti>/content — redeem a capability from
 * the Authorization header and stream the associated revision.
 */
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { bearerValue, throwArchiveError } from '$lib/server/archive/route';
import { redeemCapability } from '$lib/server/archive/db';
import { getArchiveFetcher } from '$lib/server/archive/dataplane';
import { streamRevisionContent } from '$lib/server/archive/stream';

async function handle(event: Parameters<RequestHandler>[0], method: 'GET' | 'HEAD'): Promise<Response> {
	try {
		const bearer = bearerValue(event.request);
		const token = bearer === event.params.jti ? bearer : null;
		const { revision } = await redeemCapability(db, token ?? '', 'all');
		return streamRevisionContent(getArchiveFetcher(event.platform?.env), revision.submittedBy, event.request, revision, method);
	} catch (e) {
		throwArchiveError(e);
	}
}

export const GET: RequestHandler = (event) => handle(event, 'GET');
export const HEAD: RequestHandler = (event) => handle(event, 'HEAD');
