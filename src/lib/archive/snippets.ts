export type SnippetOffset = { start: number; end: number };
export type HighlightSegment = { text: string; highlighted: boolean };

export function highlightSnippet(text: string, offsets: SnippetOffset[]): HighlightSegment[] {
	const normalized = offsets
		.map((offset) => ({
			start: Math.max(0, Math.min(text.length, offset.start)),
			end: Math.max(0, Math.min(text.length, offset.end))
		}))
		.filter((offset) => offset.end > offset.start)
		.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: SnippetOffset[] = [];
	for (const offset of normalized) {
		const last = merged.at(-1);
		if (!last || offset.start > last.end) {
			merged.push({ ...offset });
			continue;
		}
		last.end = Math.max(last.end, offset.end);
	}
	const segments: HighlightSegment[] = [];
	let cursor = 0;
	for (const offset of merged) {
		if (offset.start > cursor) segments.push({ text: text.slice(cursor, offset.start), highlighted: false });
		segments.push({ text: text.slice(offset.start, offset.end), highlighted: true });
		cursor = offset.end;
	}
	if (cursor < text.length) segments.push({ text: text.slice(cursor), highlighted: false });
	return segments;
}
