import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { getRevisionForContent } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

const MIRRORED_HEADERS = [
	'content-type',
	'content-range',
	'content-length',
	'accept-ranges',
	'etag',
	'cache-control'
] as const;

export const GET: RequestHandler = async (event) => {
	const db = routeDb(event.locals);
	const principal = await archivePrincipal(event.request, 'archive_reader', db);
	try {
		await getRevisionForContent(db, event.params.id, principal);
		const headers = new Headers();
		const range = event.request.headers.get('range');
		if (range) headers.set('range', range);
		const upstream = await dataplane.getLinearizedDerivative(
			getArchiveFetcher(event.platform?.env),
			principal.userId,
			event.params.id,
			headers
		);
		const responseHeaders = new Headers();
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
