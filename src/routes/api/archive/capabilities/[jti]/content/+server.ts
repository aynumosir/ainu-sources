/**
 * GET/HEAD /api/archive/capabilities/<jti>/content — redeem a capability from
 * the Authorization header and stream the associated revision.
 */
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { bearerValue, throwArchiveError } from '$lib/server/archive/route';
import { redeemCapability } from '$lib/server/archive/db';
import { getArchiveFetcher } from '$lib/server/archive/dataplane';
import { authorizeContent } from '$lib/server/archive/gateway';
import { streamRevisionContent } from '$lib/server/archive/stream';

async function handle(event: Parameters<RequestHandler>[0], method: 'GET' | 'HEAD'): Promise<Response> {
	try {
		const bearer = bearerValue(event.request);
		const token = bearer === event.params.jti ? bearer : null;
		const redemption = await redeemCapability(db, token ?? '', {
			kind: 'range_header',
			rangeHeader: event.request.headers.get('range')
		});
		const access = await authorizeContent(db, {
			principal: redemption.principal,
			revisionId: redemption.revisionId,
			useKind: 'capability',
			requestedBytes: redemption.chargedBytes
		});
		return streamRevisionContent(
			getArchiveFetcher(event.platform?.env),
			redemption.principal.userId,
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
