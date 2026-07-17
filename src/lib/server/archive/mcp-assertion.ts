import { hmacSha256Hex } from './crypto';

export type McpAssertionResult = { ok: true; actor: string } | { ok: false; reason: string };

export interface VerifyMcpAssertionOptions {
	now?: number;
	nonceStore?: Map<string, number>;
}

interface McpAssertionPayload {
	caller: 'mcp';
	actor: string;
	ts: number;
	nonce: string;
}

const textDecoder = new TextDecoder();
export const defaultMcpAssertionNonceStore = new Map<string, number>();

export async function verifyMcpAssertion(
	headers: Headers,
	secret: string,
	opts: VerifyMcpAssertionOptions = {}
): Promise<McpAssertionResult> {
	const assertionHeader = headers.get('X-Archive-Assertion');
	const signatureHeader = headers.get('X-Archive-Signature');
	if (!assertionHeader || !signatureHeader) return { ok: false, reason: 'missing assertion headers' };

	const rawJson = decodeBase64(assertionHeader);
	if (!rawJson) return { ok: false, reason: 'invalid assertion encoding' };

	const payload = parseMcpAssertionPayload(rawJson);
	if (!payload) return { ok: false, reason: 'invalid assertion payload' };

	const expectedSignature = await hmacSha256Hex(secret, rawJson);
	if (!isLowerHexSha256(signatureHeader) || !constantTimeEqual(signatureHeader, expectedSignature)) {
		return { ok: false, reason: 'invalid assertion signature' };
	}

	const now = opts.now ?? Math.floor(Date.now() / 1000);
	if (Math.abs(now - payload.ts) > 60) return { ok: false, reason: 'stale assertion timestamp' };

	const nonceStore = opts.nonceStore ?? defaultMcpAssertionNonceStore;
	cleanExpiredNonces(nonceStore, now);

	const nonceKey = `${payload.caller}:${payload.nonce}`;
	const existingExpiry = nonceStore.get(nonceKey);
	if (existingExpiry !== undefined && existingExpiry > now) {
		return { ok: false, reason: 'replayed assertion nonce' };
	}

	// This Map protects one isolate. Shared replay protection needs durable state.
	nonceStore.set(nonceKey, Math.max(now, payload.ts) + 60);

	return { ok: true, actor: payload.actor };
}

function decodeBase64(input: string): Uint8Array | null {
	try {
		const binary = atob(input);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
}

function parseMcpAssertionPayload(rawJson: Uint8Array): McpAssertionPayload | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(textDecoder.decode(rawJson));
	} catch {
		return null;
	}

	if (!isRecord(parsed)) return null;
	const caller = parsed.caller;
	const actor = parsed.actor;
	const ts = parsed.ts;
	const nonce = parsed.nonce;

	if (caller !== 'mcp' || typeof actor !== 'string' || actor.length === 0) return null;
	if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || typeof nonce !== 'string' || nonce.length === 0) {
		return null;
	}

	return { caller, actor, ts, nonce };
}

function constantTimeEqual(left: string, right: string): boolean {
	let diff = left.length ^ right.length;
	const maxLength = Math.max(left.length, right.length);
	for (let index = 0; index < maxLength; index += 1) {
		diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
	}
	return diff === 0;
}

function isLowerHexSha256(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

function cleanExpiredNonces(nonceStore: Map<string, number>, now: number): void {
	for (const [nonce, expiry] of nonceStore) {
		if (expiry <= now) nonceStore.delete(nonce);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
