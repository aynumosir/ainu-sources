/**
 * GET /api/archive/search — search OCR text visible to the archive principal.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { authorizeContent } from '$lib/server/archive/gateway';
import { searchOcr } from '$lib/server/archive/ocr';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, url }) => {
	const principal = await archivePrincipal(request, 'archive_reader');
	try {
		await authorizeContent(db, {
			principal,
			revisionId: null,
			useKind: 'search',
			requestedBytes: 0,
			rateUnits: 50
		});
		return json(
			await searchOcr(db, principal, {
				q: url.searchParams.get('q') ?? '',
				cursor: url.searchParams.get('cursor'),
				sourceSlug: url.searchParams.get('source_slug'),
				maxChars: parseMaxChars(url.searchParams.get('max_chars'))
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};

function parseMaxChars(value: string | null): number | undefined {
	if (value == null) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ArchiveHttpError(400, 'invalid max_chars');
	return parsed;
}
