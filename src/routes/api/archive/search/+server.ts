/**
 * GET /api/archive/search — search OCR text visible to the archive principal.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { authorizeContent } from '$lib/server/archive/gateway';
import { searchArchive } from '$lib/server/archive/ocr';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';
import type { SearchMode, SearchTolerance } from '$lib/server/archive/search-modes';

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
			await searchArchive(db, principal, {
				q: url.searchParams.get('q') ?? '',
				mode: parseMode(url.searchParams.get('mode')),
				tolerance: parseTolerance(url.searchParams.get('tolerance')),
				cursor: url.searchParams.get('cursor'),
				sourceSlug: url.searchParams.get('source') ?? url.searchParams.get('source_slug'),
				variant: url.searchParams.get('variant'),
				maxChars: parseMaxChars(url.searchParams.get('max_chars'))
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};

function parseMode(value: string | null): SearchMode {
	const mode = value ?? 'phrase';
	if (!['phrase', 'regex', 'soft', 'similar', 'semantic'].includes(mode)) {
		throw new ArchiveHttpError(400, 'invalid search mode');
	}
	return mode as SearchMode;
}

function parseTolerance(value: string | null): SearchTolerance {
	const tolerance = value ?? 'normal';
	if (!['strict', 'normal', 'loose'].includes(tolerance)) {
		throw new ArchiveHttpError(400, 'invalid search tolerance');
	}
	return tolerance as SearchTolerance;
}

function parseMaxChars(value: string | null): number | undefined {
	if (value == null) return undefined;
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ArchiveHttpError(400, 'invalid max_chars');
	return parsed;
}
