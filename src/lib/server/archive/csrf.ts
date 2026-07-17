import { env } from '$env/dynamic/private';
import { ArchiveHttpError } from './errors';
import { canonicalJson, hmacSha256, safeEqual, base64url, fromBase64url } from './crypto';

const DEFAULT_ORIGIN = 'https://archive.aynu.org';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

type TokenPayload = { uid: string; exp: string };

function configuredOrigin(): string {
	return env.ARCHIVE_ORIGIN || DEFAULT_ORIGIN;
}

async function csrfSecret(): Promise<string> {
	const secret = env.ARCHIVE_CSRF_SECRET || env.ASSERTION_KEY_SOURCES;
	if (!secret) throw new ArchiveHttpError(503, 'archive CSRF is not configured');
	return secret;
}

export function requireArchiveOrigin(request: Request): void {
	if (request.headers.get('origin') !== configuredOrigin()) throw new ArchiveHttpError(403, 'invalid archive origin');
}

export function requireJsonContent(request: Request): void {
	const contentType = request.headers.get('content-type') ?? '';
	if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) {
		throw new ArchiveHttpError(415, 'expected application/json');
	}
}

export async function issueArchiveCsrfToken(userId: string, now = new Date()): Promise<string> {
	const payload: TokenPayload = { uid: userId, exp: new Date(now.getTime() + MAX_AGE_MS).toISOString() };
	const body = base64url(new TextEncoder().encode(canonicalJson(payload)));
	return `${body}.${await hmacSha256(await csrfSecret(), body)}`;
}

export async function verifyArchiveCsrfToken(token: string | null, userId: string, now = new Date()): Promise<void> {
	if (!token) throw new ArchiveHttpError(403, 'missing CSRF token');
	const [body, sig, extra] = token.split('.');
	if (!body || !sig || extra !== undefined) throw new ArchiveHttpError(403, 'invalid CSRF token');
	const expected = await hmacSha256(await csrfSecret(), body);
	if (!safeEqual(sig, expected)) throw new ArchiveHttpError(403, 'invalid CSRF token');
	let payload: TokenPayload;
	try {
		payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as TokenPayload;
	} catch {
		throw new ArchiveHttpError(403, 'invalid CSRF token');
	}
	if (payload.uid !== userId || Date.parse(payload.exp) <= now.getTime()) {
		throw new ArchiveHttpError(403, 'invalid CSRF token');
	}
}

export async function requireArchiveMutationGuards(request: Request, userId: string): Promise<void> {
	requireArchiveOrigin(request);
	requireJsonContent(request);
	// Stateless HMAC tokens keep the control plane deployable on plain Workers:
	// no Durable Object or sticky session is needed, and revocation is handled by
	// the short expiry plus the role check that every mutating route already runs.
	await verifyArchiveCsrfToken(request.headers.get('x-archive-csrf'), userId);
}
