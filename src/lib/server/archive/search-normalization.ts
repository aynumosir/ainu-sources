import { convertKanaToLatn } from 'ainconv';

export const OCR_NORMALIZATION_VERSION = 1;

const APOSTROPHES = /[\u0060\u00b4\u02b9\u02bc\u055a\u2018\u2019\u201b\uff07]/gu;
const KANA_RUN = /[\p{Script_Extensions=Katakana}\p{Script_Extensions=Hiragana}\u3099\u309a\u30fb\u30fc]+/gu;
const TOKEN = /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu;

const LOSSY_LATIN_GROUPS = [
	['tu', 'tow'],
	['ai', 'ay', 'a.i'],
	['ui', 'uy', 'u.i'],
	['ei', 'ey', 'e.i'],
	['oi', 'oy', 'o.i'],
	['au', 'aw', 'a.u'],
	['iu', 'iw', 'i.u'],
	['eu', 'ew', 'e.u'],
	['ou', 'ow', 'o.u']
] as const;

export type NormalizedToken = { token: string; position: number };

/**
 * Normalized text is built from independent units: each maximal kana run is
 * converted as a whole, every other code point is folded alone (apostrophe
 * variants, canonical marks, case, ß). The normalized text is exactly the
 * concatenation of the normalized units, which is what lets
 * {@link buildNormalizedTextMap} map offsets in one pass. Folding is unit-local
 * by design: a Greek word-final sigma folds to σ rather than ς, and Hangul
 * jamo stay decomposed, because both outcomes need context across units.
 * Neither script occurs in this corpus.
 */
export function normalizeOcrText(text: string): string {
	let normalized = '';
	scanNormalizedUnits(text, (piece) => {
		normalized += piece;
	});
	return normalized;
}

const UNIT_CACHE_LIMIT = 8192;
const kanaRunCache = new Map<string, string>();
const codePointCache = new Map<string, string>();

/** Kana conversion dominates normalization cost and runs repeat across any
 * real page, so each run's folded result is memoized with a hard size bound. */
function normalizeKanaRun(run: string): string {
	let normalized = kanaRunCache.get(run);
	if (normalized === undefined) {
		normalized = foldLatin(convertKanaToLatn(run));
		if (kanaRunCache.size >= UNIT_CACHE_LIMIT) kanaRunCache.clear();
		kanaRunCache.set(run, normalized);
	}
	return normalized;
}

function foldCodePoint(char: string): string {
	let folded = codePointCache.get(char);
	if (folded === undefined) {
		folded = foldLatin(char.replace(APOSTROPHES, "'"));
		if (codePointCache.size >= UNIT_CACHE_LIMIT) codePointCache.clear();
		codePointCache.set(char, folded);
	}
	return folded;
}

/** Diacritics are deleted rather than preserved: OCR apostrophes, accents, and
 * long-vowel marks must not block a match. */
function foldLatin(unit: string): string {
	return unit
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLocaleLowerCase('und')
		.replaceAll('ß', 'ss');
}

type NormalizedUnitEmitter = (piece: string, unitStart: number, unitEnd: number) => void;

/**
 * Walks the text in normalization units — a maximal kana run, or one code
 * point — and hands each unit's normalized piece to `emit` with its source
 * span. Both normalizeOcrText and buildNormalizedTextMap run on this scanner,
 * so their outputs cannot drift apart. The sticky run matcher is created per
 * call: a shared one would carry mutable lastIndex between invocations.
 */
function scanNormalizedUnits(text: string, emit: NormalizedUnitEmitter): void {
	const kanaRunAt = new RegExp(KANA_RUN.source, 'uy');
	let index = 0;
	while (index < text.length) {
		kanaRunAt.lastIndex = index;
		const run = kanaRunAt.exec(text);
		let unit: string;
		let piece: string;
		if (run) {
			unit = run[0];
			piece = normalizeKanaRun(unit);
		} else {
			// codePointAt keeps lone surrogates one UTF-16 unit long, so the
			// final boundary always lands exactly on text.length.
			const unitLength = (text.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
			unit = text.slice(index, index + unitLength);
			piece = foldCodePoint(unit);
		}
		emit(piece, index, index + unit.length);
		index += unit.length;
	}
}

export type NormalizedTextMap = {
	/** normalizeOcrText of the source text. */
	normalized: string;
	/** UTF-16 offset in the source text where normalization unit i starts (a
	 * kana run or one code point); the last entry is text.length. */
	rawBoundaries: number[];
	/** Length of {@link normalized} produced by the source prefix that ends at
	 * rawBoundaries[i]. */
	prefixLengths: number[];
	/** Source-text offset of a normalized-text offset. `end` selects the
	 * boundary that closes the unit containing the offset rather than the one
	 * that opens it. */
	rawOffsetFor(normalizedOffset: number, end: boolean): number;
};

/**
 * Normalized text with the raw↔normalized boundary table needed to translate
 * match offsets back into the source text, built in one pass. Re-normalizing
 * every prefix to learn these boundaries costs quadratic time, which a
 * katakana-heavy page cannot afford.
 */
export function buildNormalizedTextMap(text: string): NormalizedTextMap {
	const rawBoundaries: number[] = [0];
	const prefixLengths: number[] = [0];
	let normalized = '';
	scanNormalizedUnits(text, (piece, _unitStart, unitEnd) => {
		normalized += piece;
		rawBoundaries.push(unitEnd);
		prefixLengths.push(normalized.length);
	});
	return {
		normalized,
		rawBoundaries,
		prefixLengths,
		rawOffsetFor(normalizedOffset: number, end: boolean) {
			let low = 0;
			let high = prefixLengths.length - 1;
			while (low < high) {
				const mid = (low + high) >> 1;
				if (end ? prefixLengths[mid] >= normalizedOffset : prefixLengths[mid] > normalizedOffset) high = mid;
				else low = mid + 1;
			}
			// No boundary satisfies the predicate when the offset sits past the
			// final unit; the text end is the honest answer there.
			if (!end && prefixLengths[low] <= normalizedOffset) return rawBoundaries[rawBoundaries.length - 1];
			return rawBoundaries[end ? low : Math.max(0, low - 1)];
		}
	};
}

export function tokenizeNormalizedText(text: string): NormalizedToken[] {
	return [...normalizeOcrText(text).matchAll(TOKEN)].map((match, position) => ({
		token: match[0],
		position
	}));
}

export function expandNormalizedTokenAlternatives(token: string): string[] {
	const normalized = normalizeOcrText(token);
	const alternatives = new Set([normalized]);
	const queue = [normalized];
	while (queue.length > 0 && alternatives.size < 32) {
		const value = queue.shift()!;
		for (const group of LOSSY_LATIN_GROUPS) {
			for (const form of group) {
				let index = value.indexOf(form);
				while (index !== -1) {
					for (const alternative of group) {
						const expanded = value.slice(0, index) + alternative + value.slice(index + form.length);
						if (!alternatives.has(expanded)) {
							alternatives.add(expanded);
							queue.push(expanded);
						}
					}
					index = value.indexOf(form, index + 1);
				}
			}
		}
	}
	return [...alternatives];
}

export function escapeFtsLiteral(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function literalPhraseAlternatives(value: string): string[] {
	const original = value.normalize('NFC');
	const normalized = normalizeOcrText(original);
	return original === normalized ? [original] : [original, normalized];
}
