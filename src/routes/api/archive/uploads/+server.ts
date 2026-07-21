/**
 * GET /api/archive/uploads lists resumable upload sessions. POST creates an
 * upload session or a deduplicated pending revision for an already verified blob.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { attachDataplaneUpload, createUploadSession, listUploadSessions, markUploadSessionFailed } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, archivePrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, url, locals }) => {
	const db = routeDb(locals);
	const principal = await archivePrincipal(request, 'archive_contributor', db);
	try {
		return json(
			await listUploadSessions(db, principal, {
				states: parseStateParam(url.searchParams.get('state')),
				all: url.searchParams.get('all') === '1'
			})
		);
	} catch (e) {
		throwArchiveError(e);
	}
};

export const POST: RequestHandler = async ({ request, platform, locals }) => {
	const db = routeDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_contributor', db);
	const body = await readJsonObject(request);
	try {
		const created = await createUploadSession(db, principal, {
			sourceSlug: String(body.source_slug ?? body.sourceSlug ?? ''),
			role: String(body.role ?? ''),
			checkoutRepo: typeof body.checkout_repo === 'string' ? body.checkout_repo : null,
			checkoutPath: typeof body.checkout_path === 'string' ? body.checkout_path : null,
			bytes: Number(body.size ?? body.bytes),
			sha256: String(body.sha256 ?? ''),
			declaredMediaType: String(body.declared_media_type ?? body.declaredMediaType ?? '')
		});
		if (created.kind === 'deduplicated') {
			return json({ deduplicated: true, revisionId: created.revision.id, fileId: created.sourceFile.id }, { status: 200 });
		}
		const response = await dataplane.multipartCreate(getArchiveFetcher(platform?.env), principal.userId, {
			sessionId: created.session.id,
			expectedSha256: created.session.expectedSha256,
			expectedBytes: created.session.expectedBytes,
			declaredMediaType: created.session.declaredMediaType
		});
		const text = await safeResponseText(response);
		if (!response.ok) {
			const message = upstreamErrorMessage(response.status, text);
			await markUploadSessionFailed(db, created.session.id, message);
			throw error(500, message);
		}
		const dataplaneBody = parseDataplaneCreateResponse(text);
		if (!dataplaneBody) {
			const message = 'archive dataplane multipart create returned malformed response';
			await markUploadSessionFailed(db, created.session.id, message);
			throw error(500, message);
		}
		const upload = await attachDataplaneUpload(db, created.session.id, {
			stagingKey: dataplaneBody.stagingKey,
			multipartId: dataplaneBody.uploadId
		});
		return json({ upload, dataplane: dataplaneBody }, { status: 201 });
	} catch (e) {
		throwArchiveError(e);
	}
};

async function safeResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

function upstreamErrorMessage(status: number, text: string): string {
	try {
		const body = JSON.parse(text) as { error?: unknown };
		if (typeof body.error === 'string' && body.error.trim()) return truncate(body.error.trim());
	} catch {
		// Fall through to the raw body.
	}
	const raw = text.trim();
	return raw ? truncate(raw) : `archive dataplane multipart create failed with HTTP ${status}`;
}

function parseDataplaneCreateResponse(text: string): { stagingKey: string; uploadId: string } | null {
	try {
		const body = JSON.parse(text) as { stagingKey?: unknown; uploadId?: unknown };
		if (typeof body.stagingKey === 'string' && typeof body.uploadId === 'string') {
			return { stagingKey: body.stagingKey, uploadId: body.uploadId };
		}
	} catch {
		return null;
	}
	return null;
}

function truncate(value: string): string {
	return value.length > 500 ? `${value.slice(0, 500)}...` : value;
}

function parseStateParam(value: string | null): string[] | null {
	if (value == null || value.trim() === '') return null;
	return value.split(',').map((state) => state.trim()).filter(Boolean);
}

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
