import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { authorizeContent } from '$lib/server/archive/gateway';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

type DerivativeWidth = 300 | 1200;

function parsePage(value: string): number {
	const raw = value.replace(/\.webp$/u, '');
	if (!/^[1-9][0-9]*$/u.test(raw)) throw error(400, 'invalid page');
	const page = Number(raw);
	if (!Number.isSafeInteger(page)) throw error(400, 'invalid page');
	return page;
}

function parseWidth(value: string | null): DerivativeWidth {
	if (value === null || value === '1200') return 1200;
	if (value === '300') return 300;
	throw error(400, 'invalid width');
}

export const GET: RequestHandler = async (event) => {
	const db = routeDb(event.locals);
	const principal = await archivePrincipal(event.request, 'archive_reader', db);
	try {
		const page = parsePage(event.params.page);
		const width = parseWidth(new URL(event.request.url).searchParams.get('w'));
		const access = await authorizeContent(db, {
			principal,
			revisionId: event.params.id,
			useKind: 'page_image'
		});
		const upstream = await dataplane.getPageDerivative(
			getArchiveFetcher(event.platform?.env),
			principal.userId,
			event.params.id,
			page,
			width
		);
		if (!upstream.ok) return new Response(null, { status: 404 });

		// Page images are copyrighted material behind per-user authorization.
		// A shared or public cache would keep serving them after a role is
		// revoked or a revision is taken down, so caching stays private and
		// short-lived even though the bytes themselves are immutable.
		const headers = new Headers({
			'content-type': 'image/webp',
			'referrer-policy': 'no-referrer'
		});
		if (access.cachePolicy.cacheControl) headers.set('cache-control', access.cachePolicy.cacheControl);
		for (const name of ['etag', 'content-length']) {
			const value = upstream.headers.get(name);
			if (value) headers.set(name, value);
		}
		return new Response(upstream.body, { status: 200, headers });
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
