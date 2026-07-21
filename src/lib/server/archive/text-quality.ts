/**
 * Detect specific ways a text variant is broken.
 *
 * Some publisher text layers store a positioned fragment per character. They
 * extract without error and reassemble into nonsense — lines shorter than a
 * word, Latin words split across several. That failure is unmistakable and
 * worth recording, because such a variant is present, looks complete, and
 * cannot be read.
 *
 * Other publisher text layers store a space between every CJK character. The
 * extraction succeeds and lines are long, yet the text reads
 * 「ア イ ヌ 語 カ ラ フ ト ラ イ シ カ」 with a space at every join. Clean
 * Japanese and kana prose carries no whitespace inside a CJK run, so a variant
 * whose CJK runs are almost all one character long is broken the same way:
 * present, complete-looking, and unreadable. Ainu kana text is katakana and
 * counts as CJK here.
 *
 * This does NOT certify that anything is accurate. Measurements across this
 * collection show the obvious signals — median line length, share of very short
 * lines, share of one-character Latin tokens — do not separate sound text from
 * mildly damaged text: a legible illustrated dictionary scores much like a
 * suspect one. Anything short of the unmistakable failures is therefore left
 * unassessed rather than called sound, since a false assurance about a source
 * is worse than an absent one. Judging accuracy needs a reference transcription
 * and is done separately.
 */

export type Reliability = 'unassessed' | 'suspect';
export type QualityVerdict = { reliability: Reliability; note: string | null };
export type QualitySample = { page: number; text: string };

/** Below this, lines are shorter than words in every script in the collection. */
const BROKEN_MEDIAN_LINE = 5;
/** Below this median CJK run length, whitespace stands between nearly every character. */
const BROKEN_MEDIAN_CJK_RUN = 2;
/** Fewer CJK characters than this across the samples is too little text to judge. */
const MIN_CJK_MASS = 50;

/** Han, hiragana, and katakana runs. */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function assessTextQuality(samples: QualitySample[]): QualityVerdict {
	const lines = samples
		.flatMap((sample) => sample.text.split('\n'))
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) {
		return { reliability: 'suspect', note: 'the sampled pages carry no text' };
	}

	const medianLength = median(lines.map((line) => [...line].length));
	if (medianLength < BROKEN_MEDIAN_LINE) {
		return {
			reliability: 'suspect',
			note: `lines run to ${medianLength} characters, so the text is fragments rather than words`
		};
	}

	const runs = samples.flatMap((sample) =>
		[...sample.text.matchAll(CJK_RUN)].map((match) => [...match[0]].length)
	);
	const cjkMass = runs.reduce((sum, length) => sum + length, 0);
	if (cjkMass >= MIN_CJK_MASS) {
		const medianRun = median(runs);
		if (medianRun < BROKEN_MEDIAN_CJK_RUN) {
			return {
				reliability: 'suspect',
				note: `CJK runs run to ${medianRun} characters at the median, so whitespace splits the text into single characters`
			};
		}
	}
	return { reliability: 'unassessed', note: null };
}
