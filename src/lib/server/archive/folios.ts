/**
 * Recover the page number a book prints on itself.
 *
 * The archive addresses pages by position in the scan, which is unambiguous but
 * is not what a reader cites: front matter, plates, and covers push the printed
 * folio out of step, often by several pages. A citation taken from the archive
 * should name the number on the page.
 *
 * The folio is read from the text the page already has, whatever its source, so
 * this works for extracted, recognized, and converted text alike and needs no
 * second pass over the images.
 *
 * A number appearing alone near the top or bottom of a page is only a candidate.
 * Running heads, dates, and table cells look the same. What distinguishes a
 * folio is that it advances by one across consecutive pages, so candidates are
 * accepted only where they form such a run — and only where no competing run
 * numbers the same page differently, which happens in works full of numbered
 * tables.
 */

export type PageText = { page: number; text: string };
export type PageFolio = { page: number; label: string; value: number };

/** Digits, alone on a line, optionally decorated: "30", "— 23 —", "( 7 )", "87." */
const BARE_NUMBER = /^[\s\-—–ー()（）［\[\]］.,、。·・*]*(\d{1,4})[\s\-—–ー()（）［\[\]］.,、。·・*]*$/u;
const ROMAN = /^[\s\-—–()]*([ivxlcdm]{1,7})[\s\-—–()]*$/i;
const ROMAN_VALUES: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };

function romanValue(text: string): number | null {
	const chars = [...text.toLowerCase()];
	if (chars.some((c) => !(c in ROMAN_VALUES))) return null;
	let total = 0;
	for (let i = 0; i < chars.length; i += 1) {
		const value = ROMAN_VALUES[chars[i]];
		const next = i + 1 < chars.length ? ROMAN_VALUES[chars[i + 1]] : 0;
		total += value < next ? -value : value;
	}
	return total > 0 && total < 400 ? total : null;
}

/**
 * Numbers standing alone in the first or last few lines of a page. Only the
 * edges are considered: a number alone in the middle of a page is part of the
 * content, not the folio.
 */
function candidates(text: string): { label: string; value: number }[] {
	const lines = text
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return [];
	const edges = [...lines.slice(0, 3), ...lines.slice(-3)];
	const found: { label: string; value: number }[] = [];
	for (const line of edges) {
		if (line.length > 24) continue;
		const arabic = BARE_NUMBER.exec(line);
		if (arabic) {
			found.push({ label: arabic[1], value: Number(arabic[1]) });
			continue;
		}
		const roman = ROMAN.exec(line);
		if (roman) {
			const value = romanValue(roman[1]);
			if (value != null) found.push({ label: roman[1].toLowerCase(), value });
		}
	}
	return found;
}

/**
 * Accept only candidates that sit in a run of consecutive numbering. `offset`
 * is folio minus scan position; a genuine folio run holds one offset steady
 * across many pages, while stray numbers do not agree with their neighbours.
 */
export function detectFolios(pages: PageText[], minRun = 8): PageFolio[] {
	const byOffset = new Map<number, Map<number, { label: string; value: number }>>();
	for (const { page, text } of pages) {
		for (const candidate of candidates(text)) {
			const offset = candidate.value - page;
			if (!byOffset.has(offset)) byOffset.set(offset, new Map());
			if (!byOffset.get(offset)!.has(page)) byOffset.get(offset)!.set(page, candidate);
		}
	}

	// Collect every run long enough to look like numbering, from every offset.
	const claims = new Map<number, PageFolio[]>();
	for (const [, pagesAtOffset] of byOffset) {
		const sorted = [...pagesAtOffset.keys()].sort((a, b) => a - b);
		let runStart = 0;
		for (let i = 1; i <= sorted.length; i += 1) {
			const broken = i === sorted.length || sorted[i] !== sorted[i - 1] + 1;
			if (!broken) continue;
			if (i - runStart >= minRun) {
				for (let j = runStart; j < i; j += 1) {
					const page = sorted[j];
					const candidate = pagesAtOffset.get(page)!;
					if (!claims.has(page)) claims.set(page, []);
					claims.get(page)!.push({ page, label: candidate.label, value: candidate.value });
				}
			}
			runStart = i;
		}
	}

	// Books with tables of numbers produce several plausible runs at once, and
	// picking between them would be guessing. A page numbered two different
	// ways is left unnumbered: a citation with no folio is a smaller problem
	// than a citation with the wrong one.
	const resolved: PageFolio[] = [];
	for (const [, options] of claims) {
		const distinct = new Set(options.map((option) => option.value));
		if (distinct.size === 1) resolved.push(options[0]);
	}
	return resolved.sort((a, b) => a.page - b.page);
}
