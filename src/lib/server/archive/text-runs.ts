/**
 * Script-run extraction shared by the language-composition scorer and the
 * profile builder. Both must cut text into identical units — a trigram
 * counted one way and scored another would measure the difference between
 * the two cuts, not the language.
 */

// The voicing marks are Script=Inherited, so without them a run would split
// inside ㇷ゚ — the sequence has no precomposed form.
export const KANA_RUN = /[\p{Script=Katakana}ー゙゚゛゜]+/gu;
export const LATN_RUN = /[\p{Script=Latin}]+(?:['’=-][\p{Script=Latin}]+)*/gu;
export const JPN_ANCHOR = /[\p{Script=Han}\p{Script=Hiragana}]/gu;
export const CYRL_RUN = /[\p{Script=Cyrillic}]+/gu;

export function countMatchedChars(line: string, re: RegExp): number {
	let n = 0;
	for (const m of line.matchAll(re)) n += [...m[0]].length;
	return n;
}

export function runsOf(line: string, re: RegExp): string[] {
	return [...line.matchAll(re)].map((m) => m[0]);
}

/**
 * Katakana with voicing marks removed. Modern Ainu kana writes no voiced
 * kana at all, while kana-only historical sources voice freely (ベ for pe),
 * so voicing separates eras of orthography rather than languages. Scoring
 * and profile building both canonicalize, and the languages stay separable
 * through what remains: small final kana, ー, and syllable shape.
 */
export function canonicalKana(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[゙゚゛゜]/gu, '')
		.normalize('NFC');
}

/** Pad each run so trigrams see word boundaries, then pool runs of a line. */
export function pooledUnit(runs: readonly string[]): string {
	return runs.map((run) => ` ${run} `).join('');
}

/** Character trigrams of a padded unit; all-space grams carry no signal and are dropped. */
export function runTrigrams(unit: string): string[] {
	const chars = [...unit];
	const out: string[] = [];
	for (let i = 0; i <= chars.length - 3; i += 1) {
		const gram = chars.slice(i, i + 3).join('');
		if (gram.trim().length >= 2) out.push(gram);
	}
	return out;
}
