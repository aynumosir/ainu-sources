import { getLocale } from '$lib/paraglide/runtime';
import type { Locale } from '$lib/constants';
import type { Source } from '$lib/server/db/schema';

// ---------------------------------------------------------------------------
// slugify — transliterating, pure string → string (Workers-safe, no native deps)
// ---------------------------------------------------------------------------

/** Hiragana → Hepburn romaji. Katakana is shifted into this block first. */
const KANA: Record<string, string> = {
	あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
	か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
	さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
	た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
	な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
	は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
	ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
	や: 'ya', ゆ: 'yu', よ: 'yo',
	ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
	わ: 'wa', ゐ: 'wi', ゑ: 'we', を: 'o',
	が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
	ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
	だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
	ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
	ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
	ゔ: 'vu',
	ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
	ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
	ゕ: 'ka', ゖ: 'ke'
};
/** Small ゃゅょ — merge into a preceding i-row syllable (きゃ→kya, しゃ→sha). */
const SMALL_Y: Record<string, string> = { ゃ: 'ya', ゅ: 'yu', ょ: 'yo' };
/** Small vowels — replace the preceding syllable's vowel (ふぃ→fi, てぃ→ti, くゎ→kwa). */
const SMALL_V: Record<string, string> = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゎ: 'wa' };

/**
 * Deterministic kana → Hepburn romaji for ONE kana run: digraphs (きゃ→kya,
 * しゃ→sha, じゅ→ju), small-vowel combos (ふぃ→fi), っ gemination (にっぽん→nippon),
 * ん→n, and the ー long-vowel mark (doubles the previous vowel). Doubled vowels
 * and ou then collapse to a single letter (とうきょう→tokyo, コーヒー→kohi).
 */
function kanaToRomaji(run: string): string {
	// katakana → hiragana (the table is keyed on hiragana; ー is handled below)
	const hira = run.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
	const out: string[] = [];
	let sokuon = false;
	for (const ch of hira) {
		if (ch === 'っ') { sokuon = true; continue; }
		if (ch === 'ん') { out.push('n'); sokuon = false; continue; }
		if (ch === 'ー') {
			const v = out[out.length - 1]?.at(-1);
			if (v && 'aiueo'.includes(v)) out.push(v);
			continue;
		}
		const prev = out[out.length - 1];
		if (prev && SMALL_Y[ch] && prev.endsWith('i') && prev !== 'i') {
			const stem = prev.slice(0, -1);
			out[out.length - 1] = stem + (/(?:sh|ch|j)$/.test(stem) ? SMALL_Y[ch].slice(1) : SMALL_Y[ch]);
			continue;
		}
		if (prev && SMALL_V[ch] && prev.length > 1 && 'aiueo'.includes(prev.at(-1) ?? '')) {
			out[out.length - 1] = prev.slice(0, -1) + SMALL_V[ch];
			continue;
		}
		const r = KANA[ch];
		if (r === undefined) { out.push(ch); sokuon = false; continue; } // rare marks pass through
		out.push(sokuon ? r[0] + r : r);
		sokuon = false;
	}
	return out.join('').replace(/ou/g, 'o').replace(/([aiueo])\1/g, '$1');
}

/** Cyrillic → Latin (GOST-ish, matches common library romanization). ъ/ь drop. */
const CYRILLIC: Record<string, string> = {
	а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
	и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
	с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
	щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya'
};

/** Latin letters NFKD cannot decompose to base + combining mark. */
const LATIN_FOLD: Record<string, string> = {
	ł: 'l', ø: 'o', đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th'
};

/** Cap at `max` chars, cutting at a hyphen (word) boundary — never mid-word. */
function capAtBoundary(s: string, max: number): string {
	if (s.length <= max) return s;
	const head = s.slice(0, max + 1);
	const cut = head.lastIndexOf('-');
	return (cut > 0 ? head.slice(0, cut) : s.slice(0, max)).replace(/-+$/, '');
}

/**
 * Slugify a string into lowercase-ASCII hyphenated form, TRANSLITERATING
 * rather than stripping: kana (hiragana + katakana, incl. halfwidth) → Hepburn
 * romaji, Cyrillic → Latin, European diacritics folded (NFKD + a table for the
 * non-decomposables ł/ø/ß/…). Kanji has no deterministic reading, so kanji
 * spans are SKIPPED — callers left with too little material add their own
 * uniqueness suffix (see the merge engine's buildSourceRow) or pass an
 * explicit slug. Output is ≤60 chars, cut at a word boundary.
 */
export function slugify(input: string): string {
	return capAtBoundary(
		input
			.normalize('NFKC') // composes ｶﾞ→ガ, й, ё; folds full-width Latin → ASCII
			.replace(/[ぁ-ヿ]+/g, (run) => ` ${kanaToRomaji(run)} `)
			.toLowerCase()
			.replace(/[Ѐ-ӿ]/g, (c) => CYRILLIC[c] ?? c)
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '') // strip decomposed diacritics
			.replace(/[łøđðßæœþ]/g, (c) => LATIN_FOLD[c])
			.replace(/['’"]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.replace(/-{2,}/g, '-'),
		60
	);
}

/** Convert a year into its century number (1875 → 19). null-safe. */
export function centuryOf(year: number | null | undefined): number | null {
	if (year == null) return null;
	return Math.floor((year - 1) / 100) + 1;
}

const ORDINAL_EN: Record<number, string> = {
	1: 'st',
	2: 'nd',
	3: 'rd'
};
function ordinal(n: number): string {
	const v = n % 100;
	if (v >= 11 && v <= 13) return `${n}th`;
	return `${n}${ORDINAL_EN[n % 10] ?? 'th'}`;
}

/** Localized label for a century number. */
export function centuryLabel(century: number, locale?: Locale): string {
	const l = (locale ?? (getLocale() as Locale)) || 'en';
	if (l === 'ja') return `${century}世紀`;
	if (l === 'ru') return `${century} в.`;
	return `${ordinal(century)} c.`;
}

/** Display string for a source's date, honoring certainty + ranges. */
export function formatYear(source: Pick<Source, 'yearText' | 'yearStart' | 'yearEnd' | 'yearCertainty'>): string {
	if (source.yearText && source.yearText.trim()) return source.yearText.trim();
	if (source.yearStart == null) return '—';
	const base =
		source.yearEnd && source.yearEnd !== source.yearStart
			? `${source.yearStart}–${source.yearEnd}`
			: `${source.yearStart}`;
	if (source.yearCertainty === 'estimated') return `c. ${base}`;
	return base;
}

/** Pretty entry-count label, e.g. "3,749 entries". */
export function formatCount(n: number | null | undefined, label: string | null | undefined): string {
	if (n == null) return '';
	return `${n.toLocaleString('en-US')}${label ? ' ' + label : ''}`;
}

/**
 * Extract a YouTube video ID from a watch / youtu.be / embed URL.
 * Returns null for playlist-only, channel, or non-YouTube URLs.
 */
export function youtubeId(url: string | null | undefined): string | null {
	if (!url) return null;
	const m =
		url.match(/[?&]v=([\w-]{11})/) ??
		url.match(/youtu\.be\/([\w-]{11})/) ??
		url.match(/youtube\.com\/embed\/([\w-]{11})/) ??
		url.match(/youtube\.com\/shorts\/([\w-]{11})/);
	return m ? m[1] : null;
}

/**
 * External "find more" links for a person.
 *  - Wikidata and Wikipedia links are shown ONLY when verified at seed time
 *    (a real QID / an article that actually exists) — never a guess.
 *  - The remaining services are inherently *search* links (clearly so), useful
 *    for locating a researcher; they make no claim that a page exists.
 */
export function personFindLinks(person: {
	name: string;
	nameEn?: string | null;
	wikidata?: string | null;
	wikipedia?: string | null;
	researchmap?: string | null;
}): { label: string; url: string; verified: boolean }[] {
	const strip = (s: string) => s.replace(/[(（][^)）]*[)）]/g, '').trim();
	const display = strip(person.nameEn || person.name);
	const native = strip(person.name);
	const q = encodeURIComponent(display);
	const qn = encodeURIComponent(native);
	const out: { label: string; url: string; verified: boolean }[] = [];
	if (person.wikipedia) {
		out.push({ label: 'Wikipedia', url: person.wikipedia, verified: true });
	}
	if (person.wikidata && /^Q\d+$/.test(person.wikidata)) {
		out.push({
			label: 'Wikidata',
			url: `https://www.wikidata.org/wiki/${person.wikidata}`,
			verified: true
		});
	}
	// researchmap: only a verified profile is linked — no search fallback.
	if (person.researchmap) {
		out.push({
			label: 'researchmap',
			url: `https://researchmap.jp/${person.researchmap}`,
			verified: true
		});
	}
	out.push(
		{ label: 'CiNii', url: `https://cir.nii.ac.jp/all?q=${qn}`, verified: false },
		{ label: 'Google Scholar', url: `https://scholar.google.com/scholar?q=${q}`, verified: false }
	);
	return out;
}

/** Coerce a JSON-array column to a string[]. Tolerates string or array. */
export function asArray(v: unknown): string[] {
	if (Array.isArray(v)) return v as string[];
	if (typeof v === 'string' && v.trim()) {
		try {
			const parsed = JSON.parse(v);
			return Array.isArray(parsed) ? parsed : [v];
		} catch {
			return [v];
		}
	}
	return [];
}
