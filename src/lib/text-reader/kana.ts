import { convert } from 'ainconv';

const cache = new Map<string, string>();
const CACHE_LIMIT = 4000;

/**
 * Katakana rendering of a modern-Latin Ainu line, word by word. A word that
 * does not syllabify (a loan, a name, a fragment) stays in Latin rather than
 * blanking the line. The split keeps a lone `p` with the word before it, the
 * way ainconv's own splitter does, so `an p` becomes アンㇷ゚.
 */
export function kanaOf(text: string): string {
	const hit = cache.get(text);
	if (hit !== undefined) return hit;
	const out = text
		.split(/(\s+(?!p\b))/u)
		.map((w) => {
			if (!/[a-z]/iu.test(w)) return w;
			try {
				return convert(w, 'Latn', 'Kana');
			} catch {
				return w;
			}
		})
		.join('');
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(text, out);
	return out;
}
