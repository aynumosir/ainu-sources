import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { authorizeContent } from '$lib/server/archive/gateway';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
const MIRRORED_HEADERS = [
	'content-type',
	'content-range',
	'content-length',
	'accept-ranges',
	'etag'
] as const;

export const GET: RequestHandler = async (event) => {
	const db = routeDb(event.locals);
	const principal = await archivePrincipal(event.request, 'archive_reader', db);
	try {
		const access = await authorizeContent(db, {
			principal,
			revisionId: event.params.id,
			useKind: 'linearized',
			rangeHeader: event.request.headers.get('range'),
			ifRangeHeader: event.request.headers.get('if-range')
		});
		const headers = new Headers();
		const range = event.request.headers.get('range');
		if (range) headers.set('range', range);
		const upstream = await dataplane.getLinearizedDerivative(
			getArchiveFetcher(event.platform?.env),
			principal.userId,
			event.params.id,
			headers
		);
		const responseHeaders = new Headers({
			'referrer-policy': 'no-referrer'
		});
		if (access.cachePolicy.cacheControl) responseHeaders.set('cache-control', access.cachePolicy.cacheControl);
		for (const name of MIRRORED_HEADERS) {
			const value = upstream.headers.get(name);
			if (value) responseHeaders.set(name, value);
		}
		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
