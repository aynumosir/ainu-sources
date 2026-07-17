/**
 * POST /api/archive/revisions/<id>/capabilities — mint a short-lived whole-file
 * bearer capability for CLI resume and machine fetches.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { issueCapability } from '$lib/server/archive/db';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const POST: RequestHandler = async ({ request, params }) => {
	const principal = await archiveMutationPrincipal(request, 'archive_contributor');
	const body = await readJsonObject(request);
	try {
		return json({ capability: await issueCapability(db, params.id, principal, Number(body.ttl_seconds)) }, { status: 201 });
	} catch (e) {
		throwArchiveError(e);
	}
};
