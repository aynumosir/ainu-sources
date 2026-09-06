import { convert } from 'ainconv';

const cache = new Map<string, string>();

/**
 * Katakana rendering of a modern-Latin Ainu line, word by word. A word that
 * does not syllabify (a loan, a name, a fragment) stays in Latin rather than
 * blanking the line; clitic boundaries (`=`) are dropped before conversion.
 */
export function kanaOf(text: string): string {
	const hit = cache.get(text);
	if (hit !== undefined) return hit;
	const out = text
		.split(/(\s+)/u)
		.map((w) => {
			if (!/[a-z]/iu.test(w)) return w;
			try {
				return convert(w.replace(/=/gu, ''), 'Latn', 'Kana');
			} catch {
				return w;
			}
		})
		.join('');
	cache.set(text, out);
	return out;
}
