import { env } from '$env/dynamic/private';
import { ArchiveHttpError } from './errors';
import { canonicalJson, hmacSha256 } from './crypto';

export type ArchiveFetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export type CallerAssertion = {
	caller: 'sources';
	actor: string;
	ts: string;
	nonce: string;
};

export type SignedCallerAssertion = CallerAssertion & { sig: string };

export async function createCallerAssertion(actor: string, now = new Date()): Promise<SignedCallerAssertion> {
	const secret = env.ASSERTION_KEY_SOURCES;
	if (!secret) throw new ArchiveHttpError(503, 'archive dataplane assertion key is not configured');
	const assertion: CallerAssertion = {
		caller: 'sources',
		actor,
		ts: now.toISOString(),
		nonce: crypto.randomUUID()
	};
	return { ...assertion, sig: await hmacSha256(secret, canonicalJson(assertion)) };
}

function makeRequest(path: string, assertion: SignedCallerAssertion, init: RequestInit = {}): Request {
	const headers = new Headers(init.headers);
	headers.set('x-archive-caller-assertion', canonicalJson(assertion));
	if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
	return new Request(`https://archive.internal${path}`, { ...init, headers });
}

async function call(fetcher: ArchiveFetcher, path: string, actor: string, init: RequestInit = {}): Promise<Response> {
	const assertion = await createCallerAssertion(actor);
	try {
		return await fetcher.fetch(makeRequest(path, assertion, init));
	} catch {
		// Avoid logging request objects here: they contain the signed caller
		// assertion header, which is equivalent to a short-lived credential.
		throw new ArchiveHttpError(502, 'archive dataplane request failed');
	}
}

function jsonBody(value: unknown): BodyInit {
	return JSON.stringify(value);
}

export function getArchiveFetcher(platformEnv: Env | undefined, fetcher?: ArchiveFetcher): ArchiveFetcher {
	const bound = fetcher ?? platformEnv?.ARCHIVE;
	if (!bound) throw new ArchiveHttpError(503, 'archive dataplane binding is not configured');
	return bound;
}

export const dataplane = {
	multipartCreate(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/multipart/create', actor, { method: 'POST', body: jsonBody(body) });
	},
	multipartSignParts(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/multipart/sign-parts', actor, { method: 'POST', body: jsonBody(body) });
	},
	multipartComplete(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/multipart/complete', actor, { method: 'POST', body: jsonBody(body) });
	},
	multipartAbort(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/multipart/abort', actor, { method: 'POST', body: jsonBody(body) });
	},
	blobsFinalize(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/blobs/finalize', actor, { method: 'POST', body: jsonBody(body) });
	},
	derivativesLinearize(fetcher: ArchiveFetcher, actor: string, body: unknown) {
		return call(fetcher, '/internal/derivatives/linearize', actor, { method: 'POST', body: jsonBody(body) });
	},
	getBlob(fetcher: ArchiveFetcher, actor: string, sha256: string, headers?: HeadersInit) {
		return call(fetcher, `/internal/blobs/${sha256}`, actor, { method: 'GET', headers });
	},
	headBlob(fetcher: ArchiveFetcher, actor: string, sha256: string, headers?: HeadersInit) {
		return call(fetcher, `/internal/blobs/${sha256}`, actor, { method: 'HEAD', headers });
	},
	getRevisionPage(fetcher: ArchiveFetcher, actor: string, revisionId: string, page: number) {
		return call(fetcher, `/internal/revisions/${revisionId}/pages/${page}.webp`, actor, { method: 'GET' });
	}
};
