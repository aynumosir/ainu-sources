export type ByteRange = { start: number; end: number };
export type RangeResult =
	| { status: 200; range: null; contentLength: number }
	| { status: 206; range: ByteRange; contentLength: number; contentRange: string }
	| { status: 416; contentRange: string };

function parseStrongEtag(value: string | null): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return /^"[^"]+"$/u.test(trimmed) ? trimmed : null;
}

export function buildRangeResponse(
	rangeHeader: string | null,
	ifRangeHeader: string | null,
	size: number,
	etag: string
): RangeResult {
	if (!rangeHeader) return { status: 200, range: null, contentLength: size };
	if (ifRangeHeader && parseStrongEtag(ifRangeHeader) !== etag) {
		return { status: 200, range: null, contentLength: size };
	}
	const m = /^bytes=(\d*)-(\d*)$/u.exec(rangeHeader.trim());
	if (!m) return { status: 416, contentRange: `bytes */${size}` };
	const [, rawStart, rawEnd] = m;
	if (!rawStart && !rawEnd) return { status: 416, contentRange: `bytes */${size}` };
	let start: number;
	let end: number;
	if (!rawStart) {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { status: 416, contentRange: `bytes */${size}` };
		start = Math.max(size - suffix, 0);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd ? Number(rawEnd) : size - 1;
	}
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start ||
		start >= size
	) {
		return { status: 416, contentRange: `bytes */${size}` };
	}
	end = Math.min(end, size - 1);
	const contentLength = end - start + 1;
	return {
		status: 206,
		range: { start, end },
		contentLength,
		contentRange: `bytes ${start}-${end}/${size}`
	};
}

export function quotedSha256Etag(sha256: string): string {
	return `"${sha256}"`;
}
