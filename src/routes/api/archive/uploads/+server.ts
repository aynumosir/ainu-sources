/**
 * POST /api/archive/uploads — create an upload session and its logical file
 * slot in one database transaction, then begin the multipart upload in the
 * archive dataplane.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { attachDataplaneUpload, createUploadSession, markUploadSessionFailed } from '$lib/server/archive/db';
import { dataplane, getArchiveFetcher } from '$lib/server/archive/dataplane';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';

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

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
