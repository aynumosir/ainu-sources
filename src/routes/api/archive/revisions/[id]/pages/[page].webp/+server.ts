import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { getRevisionForContent } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
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
		await getRevisionForContent(db, event.params.id, principal);
		const page = parsePage(event.params.page);
		const width = parseWidth(new URL(event.request.url).searchParams.get('w'));
		const upstream = await dataplane.getPageDerivative(
			getArchiveFetcher(event.platform?.env),
			principal.userId,
			event.params.id,
			page,
			width
		);
		if (!upstream.ok) return new Response(null, { status: 404 });

		const headers = new Headers({
			'content-type': 'image/webp',
			'cache-control': 'public, max-age=31536000, immutable'
		});
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
