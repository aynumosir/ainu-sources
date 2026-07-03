import { describe, it, expect } from 'vitest';
import {
	slugify,
	centuryOf,
	centuryLabel,
	formatYear,
	formatCount,
	youtubeId,
	personFindLinks,
	asArray
} from './format';

describe('slugify', () => {
	it('lowercases and hyphenates ASCII words', () => {
		expect(slugify('Aynu Itak')).toBe('aynu-itak');
		expect(slugify('Hello, World!')).toBe('hello-world');
	});

	it('strips diacritics via NFKD normalization', () => {
		expect(slugify('Café del Mar')).toBe('cafe-del-mar');
	});

	it('removes quotes and apostrophes without leaving a separator', () => {
		expect(slugify("It's")).toBe('its');
		expect(slugify('“quoted”')).toBe('quoted');
	});

	it('collapses runs of separators and trims edge dashes', () => {
		expect(slugify('  --Foo   Bar--  ')).toBe('foo-bar');
	});

	it('transliterates katakana to Hepburn romaji (incl. halfwidth)', () => {
		expect(slugify('アイヌ')).toBe('ainu');
		expect(slugify('アイヌタイムズ')).toBe('ainutaimuzu');
		expect(slugify('ｱｲﾇﾀｲﾑｽﾞ')).toBe('ainutaimuzu'); // NFKC composes halfwidth + ゛
		expect(slugify('ヴァイオリン')).toBe('vaiorin');
	});

	it('transliterates hiragana with gemination, ん and long vowels', () => {
		expect(slugify('にっぽん')).toBe('nippon'); // っ doubles the next consonant
		expect(slugify('がっこう')).toBe('gakko'); // …and ou collapses
		expect(slugify('とうきょう')).toBe('tokyo');
		expect(slugify('コーヒー')).toBe('kohi'); // ー doubles the vowel, then collapses
	});

	it('handles small-kana digraphs and vowel combos', () => {
		expect(slugify('きゃく')).toBe('kyaku');
		expect(slugify('しゃしん')).toBe('shashin'); // sh/ch/j drop the y
		expect(slugify('まっちゃ')).toBe('maccha');
		expect(slugify('じゅんび')).toBe('junbi');
		expect(slugify('ふぃるむ')).toBe('firumu'); // small vowel replaces fu's u
	});

	it('skips kanji spans (no deterministic reading) instead of guessing', () => {
		expect(slugify('言語学')).toBe('');
		expect(slugify('アイヌ語辞典')).toBe('ainu');
	});

	it('transliterates Cyrillic', () => {
		expect(slugify('Русско-айнский словарь')).toBe('russko-aynskiy-slovar'); // й→y, ь dropped
		expect(slugify('Живое слово, ёж и щука')).toBe('zhivoe-slovo-ezh-i-shchuka');
	});

	it('folds European diacritics, incl. the NFKD-non-decomposables', () => {
		expect(slugify('Bronisław Piłsudski')).toBe('bronislaw-pilsudski');
		expect(slugify('Grönländisch für Anfänger')).toBe('gronlandisch-fur-anfanger');
	});

	it('handles mixed-script input', () => {
		expect(slugify('新版 アイヌ語入門 Introduction')).toBe('ainu-introduction');
	});

	it('caps at 60 chars, cutting at a word boundary', () => {
		const long = slugify(`${'a'.repeat(20)} ${'b'.repeat(20)} ${'c'.repeat(20)} ${'d'.repeat(20)}`);
		expect(long).toBe(`${'a'.repeat(20)}-${'b'.repeat(20)}`); // never mid-word
		expect(slugify('x'.repeat(80))).toHaveLength(60); // single overlong word: hard cut
	});
});

describe('centuryOf', () => {
	it('maps a year to its (1-based) century', () => {
		expect(centuryOf(1875)).toBe(19);
		expect(centuryOf(1900)).toBe(19);
		expect(centuryOf(1901)).toBe(20);
		expect(centuryOf(2000)).toBe(20);
		expect(centuryOf(2001)).toBe(21);
		expect(centuryOf(1)).toBe(1);
	});

	it('is null-safe', () => {
		expect(centuryOf(null)).toBeNull();
		expect(centuryOf(undefined)).toBeNull();
	});
});

describe('centuryLabel', () => {
	it('renders English ordinals', () => {
		expect(centuryLabel(19, 'en')).toBe('19th c.');
		expect(centuryLabel(21, 'en')).toBe('21st c.');
		expect(centuryLabel(22, 'en')).toBe('22nd c.');
		expect(centuryLabel(23, 'en')).toBe('23rd c.');
		expect(centuryLabel(11, 'en')).toBe('11th c.'); // 11/12/13 stay "th"
	});

	it('renders Japanese and Russian labels', () => {
		expect(centuryLabel(19, 'ja')).toBe('19世紀');
		expect(centuryLabel(19, 'ru')).toBe('19 в.');
	});

	it('falls back to the ambient locale (stubbed to en) when none is given', () => {
		expect(centuryLabel(19)).toBe('19th c.');
	});
});

describe('formatYear', () => {
	const base = { yearText: null, yearStart: null, yearEnd: null, yearCertainty: null };

	it('prefers an explicit trimmed yearText', () => {
		expect(formatYear({ ...base, yearText: '  1880s  ' })).toBe('1880s');
	});

	it('renders an em-dash placeholder when there is no start year', () => {
		expect(formatYear(base)).toBe('—');
	});

	it('renders a single year', () => {
		expect(formatYear({ ...base, yearStart: 1880 })).toBe('1880');
	});

	it('renders a range with an en-dash', () => {
		expect(formatYear({ ...base, yearStart: 1880, yearEnd: 1890 })).toBe('1880–1890');
	});

	it('collapses a range whose ends are equal', () => {
		expect(formatYear({ ...base, yearStart: 1880, yearEnd: 1880 })).toBe('1880');
	});

	it('prefixes "c." for estimated certainty', () => {
		expect(formatYear({ ...base, yearStart: 1880, yearCertainty: 'estimated' })).toBe('c. 1880');
	});
});

describe('formatCount', () => {
	it('formats with thousands separators and a label', () => {
		expect(formatCount(3749, 'entries')).toBe('3,749 entries');
	});

	it('omits the label when falsy', () => {
		expect(formatCount(1000, null)).toBe('1,000');
		expect(formatCount(5, '')).toBe('5');
	});

	it('returns an empty string for a null count', () => {
		expect(formatCount(null, 'entries')).toBe('');
		expect(formatCount(undefined, 'entries')).toBe('');
	});
});

describe('youtubeId', () => {
	it('extracts the id from watch / youtu.be / embed / shorts URLs', () => {
		expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
		expect(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
	});

	it('returns null for non-video URLs and nullish input', () => {
		expect(youtubeId('https://www.youtube.com/playlist?list=PL123')).toBeNull();
		expect(youtubeId('https://example.com')).toBeNull();
		expect(youtubeId(null)).toBeNull();
		expect(youtubeId(undefined)).toBeNull();
	});
});

describe('personFindLinks', () => {
	it('always offers CiNii + Google Scholar search links (unverified) for a bare name', () => {
		const links = personFindLinks({ name: 'Foo Bar' });
		expect(links.map((l) => l.label)).toEqual(['CiNii', 'Google Scholar']);
		expect(links.every((l) => l.verified === false)).toBe(true);
	});

	it('prepends verified Wikipedia / Wikidata / researchmap links in order', () => {
		const links = personFindLinks({
			name: '知里 真志保（ちり ましほ）',
			nameEn: 'Mashiho Chiri',
			wikipedia: 'https://en.wikipedia.org/wiki/Mashiho_Chiri',
			wikidata: 'Q123',
			researchmap: 'mashiho'
		});
		expect(links.map((l) => l.label)).toEqual([
			'Wikipedia',
			'Wikidata',
			'researchmap',
			'CiNii',
			'Google Scholar'
		]);
		const wikidata = links.find((l) => l.label === 'Wikidata');
		expect(wikidata).toMatchObject({
			url: 'https://www.wikidata.org/wiki/Q123',
			verified: true
		});
		expect(links.find((l) => l.label === 'researchmap')?.url).toBe('https://researchmap.jp/mashiho');
	});

	it('ignores a malformed wikidata id (must match /^Q\\d+$/)', () => {
		const links = personFindLinks({ name: 'Foo', wikidata: 'not-a-qid' });
		expect(links.some((l) => l.label === 'Wikidata')).toBe(false);
	});

	it('URL-encodes the display and native names in the search links', () => {
		const links = personFindLinks({ name: '知里 真志保', nameEn: 'Mashiho Chiri' });
		const cinii = links.find((l) => l.label === 'CiNii')!;
		const scholar = links.find((l) => l.label === 'Google Scholar')!;
		// CiNii searches the native name, Scholar the English display name.
		expect(cinii.url).toBe(`https://cir.nii.ac.jp/all?q=${encodeURIComponent('知里 真志保')}`);
		expect(scholar.url).toBe('https://scholar.google.com/scholar?q=Mashiho%20Chiri');
	});
});

describe('asArray', () => {
	it('passes arrays through', () => {
		expect(asArray(['a', 'b'])).toEqual(['a', 'b']);
	});

	it('parses a JSON-array string', () => {
		expect(asArray('["x","y"]')).toEqual(['x', 'y']);
	});

	it('wraps a non-JSON string as a single-element array', () => {
		expect(asArray('hello')).toEqual(['hello']);
	});

	it('returns an empty array for empty / nullish / non-string-non-array input', () => {
		expect(asArray('')).toEqual([]);
		expect(asArray('   ')).toEqual([]);
		expect(asArray(null)).toEqual([]);
		expect(asArray(undefined)).toEqual([]);
		expect(asArray(42)).toEqual([]);
	});
});
