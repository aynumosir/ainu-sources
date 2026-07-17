import { base64url, fromBase64url } from './crypto';

export type FileCursor = { updatedAt: string; id: string };
export type PageCursor = { page: number };
export type SearchCursor = { revisionId: string; variant: string; page: number };

export function encodeCursor(cursor: FileCursor): string {
	return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeCursor(value: string | null): FileCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as Partial<FileCursor>;
		if (typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string') return null;
		return { updatedAt: parsed.updatedAt, id: parsed.id };
	} catch {
		return null;
	}
}

export function encodePageCursor(cursor: PageCursor): string {
	return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodePageCursor(value: string | null): PageCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as Partial<PageCursor>;
		if (typeof parsed.page !== 'number' || !Number.isSafeInteger(parsed.page)) return null;
		return { page: parsed.page };
	} catch {
		return null;
	}
}

export function encodeSearchCursor(cursor: SearchCursor): string {
	return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function decodeSearchCursor(value: string | null): SearchCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as Partial<SearchCursor>;
		if (
			typeof parsed.revisionId !== 'string' ||
			typeof parsed.variant !== 'string' ||
			typeof parsed.page !== 'number' ||
			!Number.isSafeInteger(parsed.page)
		) {
			return null;
		}
		return { revisionId: parsed.revisionId, variant: parsed.variant, page: parsed.page };
	} catch {
		return null;
	}
}

export function compareCursor(a: FileCursor, b: FileCursor): number {
	const time = a.updatedAt.localeCompare(b.updatedAt);
	return time || a.id.localeCompare(b.id);
}
