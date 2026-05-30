import { getLocale } from '$lib/paraglide/runtime';
import type { Locale } from '$lib/constants';
import type { Source } from '$lib/server/db/schema';

/** Slugify an ASCII-ish string. Non-ASCII is stripped; callers supply
 *  explicit slugs for CJK titles. */
export function slugify(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '') // strip diacritics
		.toLowerCase()
		.replace(/['’"]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
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
