/**
 * Pure, deterministic derivation helpers extracted VERBATIM from scripts/seed.ts.
 *
 * These slugify/parse/detect/classify helpers + the curated lookup tables
 * (PERSON_ALIASES/PERSON_CANON/PERSON_ENRICH/NAME_SPACING/GAZETTEER/INSTITUTIONS/
 * TAG_DEFS/CATALOG_OVERRIDES) produce the EXACT field/entity values the current
 * catalogue projection was bootstrapped from. Importers (scripts/import/*) reuse
 * them byte-for-byte so a merge-engine re-import derives identical values — any
 * drift here would break the golden projection gate. seed.ts imports the same
 * symbols, so there is a single source of truth.
 *
 * PURE: no DB access, no crypto, no I/O, no mutable module state.
 */

export function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

export function slugify(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/['’"()]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
}

export function stripParens(s: string): string {
	return s.replace(/[(（][^)）]*[)）]/g, '').trim();
}

// A title is "Latin" only if it carries no CJK, Cyrillic or Hangul — used to
// decide whether copying it into title_en is honest (a Russian/Korean title is
// NOT an English translation of itself).
export const isLatinTitle = (s: string) => !/[぀-ヿ㐀-鿿豈-﫿Ѐ-ӿ가-힣ᄀ-ᇿ]/.test(s);

// Decode HTML entities that Crossref/J-STAGE/CiNii leave in titles. Handles
// numeric (&#8211; &#x31FB;), a focused named-entity table, and J-STAGE's
// "^|^Name;" mangling of "&Name;". A hand-list is fragile, but these cover every
// artifact the consistency audit surfaced.
export const NAMED_ENTITIES: Record<string, string> = {
	amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
	mdash: '—', ndash: '–', hellip: '…', middot: '·', times: '×', deg: '°',
	ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»',
	Uuml: 'Ü', uuml: 'ü', Ouml: 'Ö', ouml: 'ö', Auml: 'Ä', auml: 'ä', szlig: 'ß',
	eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', aacute: 'á',
	iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', oslash: 'ø'
};
export function decodeEntities(s: string): string {
	return s
		.replace(/\^\|\^([A-Za-z]+);/g, '&$1;') // un-mangle J-STAGE "^|^Uuml;" → "&Uuml;"
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, n) => NAMED_ENTITIES[n] ?? m);
}

// The set of writing systems actually present across a work's title fields, so
// the script facet reflects the text rather than a language-derived guess. A
// Japanese title yields kana/kanji even when its language code never resolved.
export function detectScripts(...parts: (string | null | undefined)[]): string[] {
	const s = parts.filter(Boolean).join(' ');
	const out: string[] = [];
	if (/[A-Za-z]/.test(s)) out.push('latn');
	if (/[぀-ゟ゠-ヿ]/.test(s)) out.push('kana');
	if (/[一-鿿㐀-䶿豈-﫿]/.test(s)) out.push('kanji');
	if (/[Ѐ-ӿ]/.test(s)) out.push('cyrl');
	if (/[가-힣ᄀ-ᇿ]/.test(s)) out.push('hang');
	return out.length ? out : ['latn'];
}

export const hasCJK = (s: string) => /[぀-ヿ㐀-鿿豈-﫿]/.test(s);

/** Parse a verbatim year string into numeric start/end + certainty. */
export function parseYear(raw: string | null | undefined): {
	yearText: string;
	yearStart: number | null;
	yearEnd: number | null;
	yearCertainty: string;
} {
	const yearText = (raw ?? '').trim();
	if (!yearText) return { yearText: '', yearStart: null, yearEnd: null, yearCertainty: 'unknown' };
	const years = (yearText.match(/\d{4}/g) ?? []).map(Number).filter((y) => y >= 1500 && y <= 2100);
	const estimated = /c\.|ca\.|頃|ごろ|\?|推定|circa/i.test(yearText);
	if (years.length === 0)
		return { yearText, yearStart: null, yearEnd: null, yearCertainty: 'unknown' };
	if (years.length === 1)
		return {
			yearText,
			yearStart: years[0],
			yearEnd: null,
			yearCertainty: estimated ? 'estimated' : 'exact'
		};
	const min = Math.min(...years);
	const max = Math.max(...years);
	return { yearText, yearStart: min, yearEnd: max, yearCertainty: estimated ? 'estimated' : 'range' };
}

// --- gazetteer: dialect token → place (approx coordinates) ---
export interface GazEntry {
	slug: string;
	name: string;
	nameEn: string;
	kind: string;
	region: string;
	lat: number;
	lng: number;
}
export const GAZETTEER: { match: RegExp; place: GazEntry }[] = [
	{ match: /沙流|saru/i, place: { slug: 'saru', name: '沙流', nameEn: 'Saru', kind: 'river', region: 'hokkaido', lat: 42.58, lng: 142.12 } },
	{ match: /千歳|chitose/i, place: { slug: 'chitose', name: '千歳', nameEn: 'Chitose', kind: 'settlement', region: 'hokkaido', lat: 42.82, lng: 141.65 } },
	{ match: /様似|samani/i, place: { slug: 'samani', name: '様似', nameEn: 'Samani', kind: 'settlement', region: 'hokkaido', lat: 42.13, lng: 142.93 } },
	{ match: /旭川|asahikawa/i, place: { slug: 'asahikawa', name: '旭川', nameEn: 'Asahikawa', kind: 'settlement', region: 'hokkaido', lat: 43.77, lng: 142.36 } },
	{ match: /浦河|urakawa/i, place: { slug: 'urakawa', name: '浦河', nameEn: 'Urakawa', kind: 'settlement', region: 'hokkaido', lat: 42.16, lng: 142.77 } },
	{ match: /鵡川|mukawa/i, place: { slug: 'mukawa', name: '鵡川', nameEn: 'Mukawa', kind: 'settlement', region: 'hokkaido', lat: 42.57, lng: 141.92 } },
	{ match: /幌別|horobetsu|登別|noboribetsu/i, place: { slug: 'horobetsu', name: '幌別', nameEn: 'Horobetsu', kind: 'settlement', region: 'hokkaido', lat: 42.41, lng: 141.1 } },
	{ match: /静内|shizunai/i, place: { slug: 'shizunai', name: '静内', nameEn: 'Shizunai', kind: 'settlement', region: 'hokkaido', lat: 42.33, lng: 142.37 } },
	{ match: /十勝|tokachi/i, place: { slug: 'tokachi', name: '十勝', nameEn: 'Tokachi', kind: 'region', region: 'hokkaido', lat: 42.92, lng: 143.2 } },
	{ match: /石狩|ishikari/i, place: { slug: 'ishikari', name: '石狩', nameEn: 'Ishikari', kind: 'region', region: 'hokkaido', lat: 43.17, lng: 141.32 } },
	{ match: /釧路|kushiro/i, place: { slug: 'kushiro', name: '釧路', nameEn: 'Kushiro', kind: 'settlement', region: 'hokkaido', lat: 42.98, lng: 144.38 } },
	{ match: /色丹|shikotan/i, place: { slug: 'shikotan', name: '色丹島', nameEn: 'Shikotan', kind: 'island', region: 'kuril', lat: 43.85, lng: 146.75 } },
	// --- Sakhalin sub-dialect areas (East/West coast + Taraika), like Hokkaidō's ---
	{ match: /多蘭泊|多来加|タライカ|taraika|小田洲|落帆|ochiho|白浦|敷香|poronaysk/i, place: { slug: 'taraika', name: '多蘭泊（タライカ）', nameEn: 'Taraika', kind: 'settlement', region: 'sakhalin', lat: 49.0, lng: 143.2 } },
	{ match: /西海岸|真岡|maoka|名好|nayoro|本斗/i, place: { slug: 'sakhalin-west', name: '樺太西海岸', nameEn: 'West Sakhalin coast', kind: 'region', region: 'sakhalin', lat: 47.5, lng: 142.0 } },
	{ match: /東海岸|内淵|naibuchi/i, place: { slug: 'sakhalin-east', name: '樺太東海岸', nameEn: 'East Sakhalin coast', kind: 'region', region: 'sakhalin', lat: 48.0, lng: 142.7 } },
	{ match: /樺太|サハリン|sakhalin|karafuto|エンチウ/i, place: { slug: 'sakhalin', name: '樺太', nameEn: 'Sakhalin', kind: 'region', region: 'sakhalin', lat: 49.5, lng: 142.5 } },
	{ match: /千島|クリル|kuril/i, place: { slug: 'kuril', name: '千島', nameEn: 'Kuril Islands', kind: 'island', region: 'kuril', lat: 45.5, lng: 149.0 } },
	{ match: /北海道|hokkaido/i, place: { slug: 'hokkaido', name: '北海道', nameEn: 'Hokkaidō', kind: 'region', region: 'hokkaido', lat: 43.4, lng: 142.8 } }
];

export function regionFor(dialect: string): string {
	if (!dialect) return '';
	const macros = new Set<string>();
	if (/樺太|サハリン|sakhalin|エンチウ|多蘭泊|多来加|タライカ|taraika|小田洲|落帆|ochiho|白浦|敷香|西海岸|真岡|maoka|名好|nayoro|本斗|東海岸|内淵|naibuchi/i.test(dialect))
		macros.add('sakhalin');
	if (/千島|色丹|クリル|kuril|shikotan/i.test(dialect)) macros.add('kuril');
	if (/祖アイヌ|proto/i.test(dialect)) macros.add('proto');
	if (/北海道|沙流|千歳|様似|旭川|浦河|鵡川|幌別|静内|十勝|石狩|釧路|hokkaido|saru|chitose|samani|asahikawa|urakawa|mukawa|horobetsu|shizunai|tokachi|ishikari|kushiro/i.test(dialect))
		macros.add('hokkaido');
	if (macros.size === 0) return '';
	if (macros.size === 1) return [...macros][0];
	return 'other';
}

export function placesFor(dialect: string): GazEntry[] {
	if (!dialect) return [];
	const found: GazEntry[] = [];
	const seen = new Set<string>();
	for (const { match, place } of GAZETTEER) {
		if (match.test(dialect) && !seen.has(place.slug)) {
			// don't add the broad "hokkaido" region if a specific place already matched
			found.push(place);
			seen.add(place.slug);
		}
	}
	// Drop a broad region pin (北海道 / 樺太 / 千島) when a more specific place of the
	// SAME region matched — but keep broad pins of other regions (e.g. bi-regional
	// 北海道・樺太 keeps both). Generalises the old Hokkaidō-only rule to Sakhalin.
	const BROAD = new Set(['hokkaido', 'sakhalin', 'kuril']);
	const specificRegions = new Set(found.filter((p) => !BROAD.has(p.slug)).map((p) => p.region));
	return found.filter((p) => !(BROAD.has(p.slug) && specificRegions.has(p.region)));
}

// --- institutions keyed by URI host ---
export interface InstEntry {
	slug: string;
	name: string;
	nameEn: string;
	country: string;
	city: string;
	lat: number;
	lng: number;
	url: string;
}
export const INSTITUTIONS: Record<string, InstEntry> = {
	'ainugo.nam.go.jp': { slug: 'nam', name: '国立アイヌ民族博物館（ウポポイ）', nameEn: 'National Ainu Museum (Upopoy)', country: 'JP', city: 'Shiraoi', lat: 42.55, lng: 141.35, url: 'https://nam.go.jp/' },
	'nam.go.jp': { slug: 'nam', name: '国立アイヌ民族博物館（ウポポイ）', nameEn: 'National Ainu Museum (Upopoy)', country: 'JP', city: 'Shiraoi', lat: 42.55, lng: 141.35, url: 'https://nam.go.jp/' },
	'ainu-upopoy.jp': { slug: 'nam', name: '国立アイヌ民族博物館（ウポポイ）', nameEn: 'National Ainu Museum (Upopoy)', country: 'JP', city: 'Shiraoi', lat: 42.55, lng: 141.35, url: 'https://nam.go.jp/' },
	'ainu.ninjal.ac.jp': { slug: 'ninjal', name: '国立国語研究所', nameEn: 'NINJAL', country: 'JP', city: 'Tachikawa', lat: 35.7, lng: 139.41, url: 'https://www.ninjal.ac.jp/' },
	'ainugo.aa-ken.jp': { slug: 'ilcaa', name: '東京外国語大学アジア・アフリカ言語文化研究所', nameEn: 'ILCAA, TUFS', country: 'JP', city: 'Fuchū', lat: 35.68, lng: 139.48, url: 'https://www.aa.tufs.ac.jp/' },
	'www.aa.tufs.ac.jp': { slug: 'ilcaa', name: '東京外国語大学アジア・アフリカ言語文化研究所', nameEn: 'ILCAA, TUFS', country: 'JP', city: 'Fuchū', lat: 35.68, lng: 139.48, url: 'https://www.aa.tufs.ac.jp/' },
	'opac.ll.chiba-u.jp': { slug: 'chiba-u', name: '千葉大学', nameEn: 'Chiba University', country: 'JP', city: 'Chiba', lat: 35.63, lng: 140.1, url: 'https://www.chiba-u.ac.jp/' },
	'www.gshpa.chiba-u.jp': { slug: 'chiba-u', name: '千葉大学', nameEn: 'Chiba University', country: 'JP', city: 'Chiba', lat: 35.63, lng: 140.1, url: 'https://www.chiba-u.ac.jp/' },
	'www.ff-ainu.or.jp': { slug: 'ff-ainu', name: '公益財団法人アイヌ民族文化財団', nameEn: 'Foundation for Ainu Culture', country: 'JP', city: 'Sapporo', lat: 43.06, lng: 141.35, url: 'https://www.ff-ainu.or.jp/' },
	'ainu-center.hm.pref.hokkaido.lg.jp': { slug: 'hokkaido-ainu-center', name: '北海道立アイヌ総合センター', nameEn: 'Hokkaido Ainu Center', country: 'JP', city: 'Sapporo', lat: 43.06, lng: 141.35, url: 'https://ainu-center.hm.pref.hokkaido.lg.jp/' },
	'minpaku.repo.nii.ac.jp': { slug: 'minpaku', name: '国立民族学博物館', nameEn: 'National Museum of Ethnology (Minpaku)', country: 'JP', city: 'Suita', lat: 34.81, lng: 135.53, url: 'https://www.minpaku.ac.jp/' },
	'waseda.repo.nii.ac.jp': { slug: 'waseda', name: '早稲田大学', nameEn: 'Waseda University', country: 'JP', city: 'Tokyo', lat: 35.71, lng: 139.72, url: 'https://www.waseda.jp/' },
	'www.hokudai.ac.jp': { slug: 'hokudai', name: '北海道大学', nameEn: 'Hokkaido University', country: 'JP', city: 'Sapporo', lat: 43.08, lng: 141.34, url: 'https://www.hokudai.ac.jp/' }
};

export function linkTypeFor(host: string): string {
	if (host.includes('opac') || host.includes('repo.nii')) return 'opac';
	if (host.includes('ndl.go.jp')) return 'ndl';
	if (host.includes('youtube') || host.includes('youtu.be')) return 'website';
	return 'website';
}

// --- person identity normalization ----------------------------------------
// Recurring scholars appear across the three repos in many spellings (bare
// surname from book dirs, "Last, First" from catalog.json, CJK from articles).
// Map every observed form → one canonical slug, with a canonical display name,
// so a person is a single record linking to all their works.
export const PERSON_ALIASES: Record<string, string> = {
	Tamura: 'tamura-suzuko', 'Tamura, Suzuko': 'tamura-suzuko', 'Tamura Suzuko': 'tamura-suzuko', 'Suzuko Tamura': 'tamura-suzuko', 田村すゞ子: 'tamura-suzuko', 田村すず子: 'tamura-suzuko', 田村寿々子: 'tamura-suzuko',
	// née Fukuda — her maiden name appears on early work
	福田すず子: 'tamura-suzuko', 福田すゞ子: 'tamura-suzuko', 'Fukuda Suzuko': 'tamura-suzuko', 'Suzuko Fukuda': 'tamura-suzuko', 'Fukuda, Suzuko': 'tamura-suzuko',
	Nakagawa: 'nakagawa-hiroshi', 'Nakagawa, Hiroshi': 'nakagawa-hiroshi', 'Nakagawa Hiroshi': 'nakagawa-hiroshi', 中川裕: 'nakagawa-hiroshi',
	Kayano: 'kayano-shigeru', 'Kayano, Shigeru': 'kayano-shigeru', 'Kayano Shigeru': 'kayano-shigeru', 萱野茂: 'kayano-shigeru',
	Sato: 'sato-tomomi', 'Sato, Tomomi': 'sato-tomomi', 'Sato Tomomi': 'sato-tomomi', 佐藤知己: 'sato-tomomi',
	Bugaeva: 'bugaeva-anna', 'Bugaeva, Anna': 'bugaeva-anna', 'Bugaeva Anna': 'bugaeva-anna', 'Anna Bugaeva': 'bugaeva-anna', 'ブガエワ・アンナ': 'bugaeva-anna', ブガエワアンナ: 'bugaeva-anna',
	// Karol Nowakowski (Sakhalin-Ainu ASR/NLP) — papers list him in Latin (OpenAlex
	// emits the 3-token "NOWAKOWSKI KAROL PIOTR"); merge all forms so researchmap attaches.
	Nowakowski: 'nowakowski-karol', 'Nowakowski Karol': 'nowakowski-karol', 'Karol Nowakowski': 'nowakowski-karol', 'Nowakowski, Karol': 'nowakowski-karol', 'Nowakowski Karol Piotr': 'nowakowski-karol', 'Karol Piotr Nowakowski': 'nowakowski-karol', 'ノヴァコフスキ・カロル': 'nowakowski-karol', ノヴァコフスキカロル: 'nowakowski-karol',
	Ijas: 'ijas-silja', Silja: 'ijas-silja', 'Ijas Silja': 'ijas-silja', 'Silja Ijas': 'ijas-silja', 'Ijäs, Silja': 'ijas-silja',
	Chiri: 'chiri-mashiho', 'Chiri, Mashiho': 'chiri-mashiho', 'Chiri Mashiho': 'chiri-mashiho', 知里真志保: 'chiri-mashiho',
	'Chiri, Yukie': 'chiri-yukie', 'Chiri Yukie': 'chiri-yukie', 知里幸恵: 'chiri-yukie', 知里幸惠: 'chiri-yukie',
	Kindaichi: 'kindaichi-kyosuke', 'Kindaichi, Kyosuke': 'kindaichi-kyosuke', 'Kindaichi Kyosuke': 'kindaichi-kyosuke', 金田一京助: 'kindaichi-kyosuke',
	Hattori: 'hattori-shiro', 'Hattori, Shiro': 'hattori-shiro', 'Hattori Shiro': 'hattori-shiro', 服部四郎: 'hattori-shiro',
	Shibatani: 'shibatani-masayoshi', 'Shibatani, Masayoshi': 'shibatani-masayoshi', 'Shibatani Masayoshi': 'shibatani-masayoshi', 柴谷方良: 'shibatani-masayoshi',
	Kirikae: 'kirikae-hideo', 切替英雄: 'kirikae-hideo',
	Fukazawa: 'fukazawa-mika', 'Fukazawa Mika': 'fukazawa-mika', 深沢美香: 'fukazawa-mika', 深澤美香: 'fukazawa-mika',
	Yasuoka: 'yasuoka-koichi', 'Yasuoka Koichi': 'yasuoka-koichi', 'Koichi Yasuoka': 'yasuoka-koichi', KoichiYasuoka: 'yasuoka-koichi', 安岡孝一: 'yasuoka-koichi',
	// --- de-duplication: kanji ⇄ Latin / variant-kanji / reversed forms of one person ---
	桃内佳雄: 'momouchi-yoshio', 'Momouchi Yoshio': 'momouchi-yoshio',
	片山龍峯: 'katayama-tatsumine', 片山竜峯: 'katayama-tatsumine', 'Katayama Tatsumine': 'katayama-tatsumine',
	鏡味明克: 'kagami-akikatsu', 'Kagami Akikatsu': 'kagami-akikatsu',
	石田肇: 'ishida-hajime', 'Ishida Hajime': 'ishida-hajime',
	鳴海日出志: 'narumi-hideshi', 'Narumi Hideshi': 'narumi-hideshi',
	Batchelor: 'batchelor-john', 'John Batchelor': 'batchelor-john', 'Batchelor John': 'batchelor-john', バチェラー: 'batchelor-john', 'ジョン バチェラー': 'batchelor-john', 'ジョン・バチェラー': 'batchelor-john', ジョンバチェラー: 'batchelor-john',
	知己佐藤: 'sato-tomomi', // surname/given reversed
	'John C. Batchelor': 'batchelor-john', 'John C Batchelor': 'batchelor-john',
	'Jeff Gayman': 'gayman-jeffry', 'Jeffry Gayman': 'gayman-jeffry', 'Jeffry Joseph Gayman': 'gayman-jeffry',
	// romaji-only Japanese researchers → recovered kanji canon (swap handles "Given Surname")
	宮川創: 'miyagawa-so', 'Miyagawa So': 'miyagawa-so', 'So Miyagawa': 'miyagawa-so', SoMiyagawa: 'miyagawa-so',
	白石英才: 'shiraishi-hidetoshi', 'Shiraishi Hidetoshi': 'shiraishi-hidetoshi',
	五十嵐涼: 'igarashi-ryo', 'Igarashi Ryo': 'igarashi-ryo',
	丸山博: 'maruyama-hiroshi', 'Maruyama Hiroshi': 'maruyama-hiroshi',
	桝井文人: 'masui-fumito', 'Masui Fumito': 'masui-fumito',
	山崎幸治: 'yamasaki-koji', 'Yamasaki Koji': 'yamasaki-koji',
	山田孝子: 'yamada-takako', 'Yamada Takako': 'yamada-takako',
	平野克弥: 'hirano-katsuya', 'Hirano Katsuya': 'hirano-katsuya',
	北海道ウタリ協会: 'hokkaido-utari-kyokai'
};
export const PERSON_CANON: Record<string, { name: string; nameEn?: string }> = {
	'tamura-suzuko': { name: '田村 すゞ子', nameEn: 'Tamura Suzuko' },
	'nakagawa-hiroshi': { name: '中川 裕', nameEn: 'Nakagawa Hiroshi' },
	'kayano-shigeru': { name: '萱野 茂', nameEn: 'Kayano Shigeru' },
	'sato-tomomi': { name: '佐藤 知己', nameEn: 'Sato Tomomi' },
	'bugaeva-anna': { name: 'Anna Bugaeva' },
	'nowakowski-karol': { name: 'Nowakowski Karol', nameEn: 'Nowakowski Karol' },
	'ijas-silja': { name: 'Ijas Silja' },
	'chiri-mashiho': { name: '知里 真志保', nameEn: 'Chiri Mashiho' },
	'chiri-yukie': { name: '知里 幸恵', nameEn: 'Chiri Yukie' },
	'kindaichi-kyosuke': { name: '金田一 京助', nameEn: 'Kindaichi Kyosuke' },
	'hattori-shiro': { name: '服部 四郎', nameEn: 'Hattori Shiro' },
	'shibatani-masayoshi': { name: 'Shibatani Masayoshi' },
	'kirikae-hideo': { name: '切替 英雄', nameEn: 'Kirikae Hideo' },
	'fukazawa-mika': { name: '深澤 美香', nameEn: 'Fukazawa Mika' },
	'yasuoka-koichi': { name: '安岡 孝一', nameEn: 'Yasuoka Koichi' },
	'momouchi-yoshio': { name: '桃内 佳雄', nameEn: 'Momouchi Yoshio' },
	'katayama-tatsumine': { name: '片山 龍峯', nameEn: 'Katayama Tatsumine' },
	'kagami-akikatsu': { name: '鏡味 明克', nameEn: 'Kagami Akikatsu' },
	'ishida-hajime': { name: '石田 肇', nameEn: 'Ishida Hajime' },
	'narumi-hideshi': { name: '鳴海 日出志', nameEn: 'Narumi Hideshi' },
	'batchelor-john': { name: 'John Batchelor' },
	'gayman-jeffry': { name: 'Jeffry Gayman' },
	// kanji recovered for romaji-only Japanese researchers (web/researchmap-verified)
	'miyagawa-so': { name: '宮川 創', nameEn: 'Miyagawa So' },
	'shiraishi-hidetoshi': { name: '白石 英才', nameEn: 'Shiraishi Hidetoshi' },
	'igarashi-ryo': { name: '五十嵐 涼', nameEn: 'Igarashi Ryo' },
	'maruyama-hiroshi': { name: '丸山 博', nameEn: 'Maruyama Hiroshi' },
	'masui-fumito': { name: '桝井 文人', nameEn: 'Masui Fumito' },
	'yamasaki-koji': { name: '山崎 幸治', nameEn: 'Yamasaki Koji' },
	'yamada-takako': { name: '山田 孝子', nameEn: 'Yamada Takako' },
	'hirano-katsuya': { name: '平野 克弥', nameEn: 'Hirano Katsuya' },
	'hokkaido-utari-kyokai': { name: '北海道ウタリ協会', nameEn: 'Hokkaido Utari Association' }
};

// Hand-verified enrichment for individuals (esp. Japanese-named researchers whose
// romaji isn't derivable from kanji). Keyed by the exact name as it appears in the
// source data. Values are confirmed against the linked profile — never guessed.
// `researchmap` is the researchmap.jp permalink (the path after the domain).
// Verified against each person's researchmap profile API (kanji + romaji read
// straight from family_name/given_name). Kanji keys are written WITHOUT the
// surname/given space; the lookup is space-insensitive (see getPerson).
export const PERSON_ENRICH: Record<string, { nameEn?: string; researchmap?: string; wikidata?: string }> =
	{
		// 田村すゞ子 (Tamura Suzuko, 1934–2015, 早大名誉教授; アイヌ語・バスク語). No
		// researchmap (deceased) — link her Wikidata so life dates fill in. Keyed by
		// canon slug; all her name variants (incl. birth name 福田すゞ子) alias to it.
		'tamura-suzuko': { nameEn: 'Tamura Suzuko', wikidata: 'Q11576823' },
		吉川佳見: { nameEn: 'Yoshikawa Yoshimi', researchmap: 'y.yoshikawa' },
		阪口諒: { nameEn: 'Sakaguchi Ryo', researchmap: 'SAKAGUCHI_Ryo' },
		丹菊逸治: { nameEn: 'Tangiku Itsuji', researchmap: 'tangikuitsuji' },
		安岡孝一: { nameEn: 'Yasuoka Koichi', researchmap: 'read0012388' },
		深澤美香: { nameEn: 'Fukazawa Mika', researchmap: 'mkfk' },
		佐藤知己: { nameEn: 'Sato Tomomi', researchmap: 'ainlingsat' },
		奥田統己: { nameEn: 'Okuda Osami', researchmap: 'read0021678' },
		小林美紀: { nameEn: 'Kobayashi Miki', researchmap: 'kobayashi_miki' },
		中川裕: { nameEn: 'Nakagawa Hiroshi', researchmap: 'read0064265' },
		遠藤志保: { nameEn: 'Endo Shiho', researchmap: 'hacrc_hm' },
		'北原モコットゥナㇱ': { nameEn: 'Mokottunas Kitahara', researchmap: '1976' },
		小野洋平: { nameEn: 'Ono Yohei', researchmap: 'ono_yohei' },
		切替英雄: { nameEn: 'Kirikae Hideo', researchmap: 'read0049566' }, // verified api.researchmap.jp 切替/英雄
		大坂拓: { nameEn: 'Osaka Taku', researchmap: 'osaka_taku' }, // verified api.researchmap.jp 大坂/拓
		春日勇人: { nameEn: 'Kasuga Hayato', researchmap: 'hayatokasuga' },
		白鳥詩織: { nameEn: 'Shiratori Shiori', researchmap: 'i_mage' },
		'Anna Bugaeva': { researchmap: 'read0144912' },
		// keyed by canonical slug so it applies no matter which name form created the person
		'sato-tomomi': { researchmap: 'ainlingsat' },
		'nakagawa-hiroshi': { researchmap: 'read0064265' },
		'fukazawa-mika': { researchmap: 'mkfk' },
		'bugaeva-anna': { researchmap: 'read0144912' },
		'kirikae-hideo': { nameEn: 'Kirikae Hideo', researchmap: 'read0049566' },
		'yasuoka-koichi': { nameEn: 'Yasuoka Koichi', researchmap: 'read0012388' },
		'miyagawa-so': { researchmap: 'SoMiyagawa' }, // verified api.researchmap.jp 宮川/創
		'shiraishi-hidetoshi': { researchmap: 'read0127694' },
		'maruyama-hiroshi': { researchmap: 'read0119850' },
		'masui-fumito': { researchmap: 'read0067315' },
		'yamasaki-koji': { researchmap: 'koji_yamasaki' },
		于拙: { nameEn: 'Cjyet Yo', researchmap: 'yocjyet' },
		// Romaji for prominent kanji-only authors (established readings; some given
		// names best-effort). Keyed by despaced kanji — getPerson looks these up.
		伊藤せいち: { nameEn: 'Itō Seichi' }, 大友幸男: { nameEn: 'Ōtomo Yukio' },
		高橋靖以: { nameEn: 'Takahashi Yasui' }, 鏡味明克: { nameEn: 'Kagami Akikatsu' },
		井筒勝信: { nameEn: 'Izutsu Katsunobu' }, 清水清次郎: { nameEn: 'Shimizu Seijirō' },
		吉原克己: { nameEn: 'Yoshihara Katsumi' }, 村上啓司: { nameEn: 'Murakami Keiji' },
		榊原正文: { nameEn: 'Sakakibara Masafumi' }, 佐藤直太郎: { nameEn: 'Satō Naotarō' },
		吉田巌: { nameEn: 'Yoshida Iwao' }, 落合いずみ: { nameEn: 'Ochiai Izumi' },
		古原敏弘: { nameEn: 'Furuhara Toshihiro' }, 岸本宜久: { nameEn: 'Kishimoto Nobuhisa' },
		鳴海日出志: { nameEn: 'Narumi Hideshi' }, 平隆一: { nameEn: 'Taira Ryūichi' },
		久保寺逸彦: { nameEn: 'Kubodera Itsuhiko', wikidata: 'Q11368989' }, 秋山秀敏: { nameEn: 'Akiyama Hidetoshi' },
		甲地利恵: { nameEn: 'Katchi Rie' }, 加藤鉄三郎: { nameEn: 'Katō Tetsusaburō' },
		福田吉次郎: { nameEn: 'Fukuda Kichijirō' }, 三好勲: { nameEn: 'Miyoshi Isao' },
		田村雅史: { nameEn: 'Tamura Masashi' }, 大谷洋一: { nameEn: 'Ōtani Yōichi' },
		後藤利雄: { nameEn: 'Gotō Toshio' }, 萩中美枝: { nameEn: 'Haginaka Mie' },
		留目政治: { nameEn: 'Todome Seiji' }, 其田良雄: { nameEn: 'Sonota Yoshio' },
		鬼春人: { nameEn: 'Oni Haruto' }, 西鶴定嘉: { nameEn: 'Saikaku Sadayoshi' },
		佐々木弘太郎: { nameEn: 'Sasaki Kōtarō' }, 岡田路明: { nameEn: 'Okada Michiaki' },
		亀丸由紀子: { nameEn: 'Kamemaru Yukiko' }, 橘善光: { nameEn: 'Tachibana Yoshimitsu' },
		小川正人: { nameEn: 'Ogawa Masato' }, 葛西猛千代: { nameEn: 'Kasai Takechiyo' },
		田中吉人: { nameEn: 'Tanaka Yoshito' }, 大野徹人: { nameEn: 'Ōno Tetsuto' },
		菱沼右一: { nameEn: 'Hishinuma Uichi' }, 横平弘: { nameEn: 'Yokohira Hiroshi' },
		本田優子: { nameEn: 'Honda Yūko' }, 白山友正: { nameEn: 'Shirayama Tomomasa' },
		知里高央: { nameEn: 'Chiri Takanaka' }, 田村将人: { nameEn: 'Tamura Masato' },
		宮崎耕太: { nameEn: 'Miyazaki Kōta' }, 間方徳松: { nameEn: 'Magata Tokumatsu' },
		澤井春美: { nameEn: 'Sawai Harumi' }, 橘正一: { nameEn: 'Tachibana Shōichi' },
		川上まつ子: { nameEn: 'Kawakami Matsuko' }, 和田完: { nameEn: 'Wada Kan' },
		岸本翠月: { nameEn: 'Kishimoto Suigetsu' }, 片山竜峯: { nameEn: 'Katayama Tatsumine' },
		大出あや子: { nameEn: 'Ōide Ayako' }, 福田友之: { nameEn: 'Fukuda Tomoyuki' },
		佐賀彩美: { nameEn: 'Saga Ayami' }, 伊藤公平: { nameEn: 'Itō Kōhei' },
		中野良宣: { nameEn: 'Nakano Yoshinobu' }, 渡辺茂: { nameEn: 'Watanabe Shigeru' },
		石田肇: { nameEn: 'Ishida Hajime' }, 井上拓也: { nameEn: 'Inoue Takuya' },
		大島稔: { nameEn: 'Ōshima Minoru' },
		成田修一: { nameEn: 'Narita Shūichi' }, 女鹿潤哉: { nameEn: 'Mega Jun’ya' },
		片山龍峯: { nameEn: 'Katayama Tatsumine' }, 菅泰雄: { nameEn: 'Suga Yasuo' },
		井口利夫: { nameEn: 'Iguchi Toshio' }, 安田千夏: { nameEn: 'Yasuda Chinatsu' },
		松井恒幸: { nameEn: 'Matsui Tsuneyuki' }, 湯淺正: { nameEn: 'Yuasa Tadashi' },
		礒部精一: { nameEn: 'Isobe Seiichi' }, 金丸継夫: { nameEn: 'Kanemaru Tsuguo' },
		上田トシ: { nameEn: 'Ueda Toshi' }, 太田満: { nameEn: 'Ōta Mitsuru' },
		安岡素子: { nameEn: 'Yasuoka Motoko' }, 木村きみ: { nameEn: 'Kimura Kimi' },
		瀧口夕美: { nameEn: 'Takiguchi Yūmi' }, 越前谷博: { nameEn: 'Echizenya Hiroshi' },
		関根健司: { nameEn: 'Sekine Kenji' }, 関根摩耶: { nameEn: 'Sekine Maya' },
		下倉絵美: { nameEn: 'Shimokura Emi' }, 中井貴規: { nameEn: 'Nakai Takanori' },
		// variant-kanji / alternate-name forms that must share a romaji to merge
		吉田巖: { nameEn: 'Yoshida Iwao' }, // 巖 = variant of 巌
		上原熊次郎: { nameEn: 'Uehara Kumajirō' }, 上原有次: { nameEn: 'Uehara Kumajirō' }, // 有次 = Kumajirō's other name
		// Ainu narrators / tradition-bearers (kana given names)
		北風磯吉: { nameEn: 'Kitakaze Isokichi' }, 山田ハヨ: { nameEn: 'Yamada Hayo' },
		平賀さだも: { nameEn: 'Hiraga Sadamo' }, 小川シゲノ: { nameEn: 'Ogawa Shigeno' },
		上野サダ: { nameEn: 'Ueno Sada' }, 平目よし: { nameEn: 'Hirame Yoshi' },
		丸野和子: { nameEn: 'Maruno Kazuko' }, 八谷麻衣: { nameEn: 'Hachiya Mai' },
		八重昌子: { nameEn: 'Yae Masako' }, 八重清敏: { nameEn: 'Yae Kiyotoshi' },
		加納ルミ子: { nameEn: 'Kanō Rumiko' }, 加藤大樹: { nameEn: 'Katō Daiki' },
		吉本裕子: { nameEn: 'Yoshimoto Yūko' }, 吉村冬子: { nameEn: 'Yoshimura Fuyuko' },
		吉村明夫: { nameEn: 'Yoshimura Akio' }, 吉田恵理佳: { nameEn: 'Yoshida Erika' },
		堀悦子: { nameEn: 'Hori Etsuko' }, 大須賀るえ子: { nameEn: 'Ōsuga Rueko' },
		天内重樹: { nameEn: 'Amanai Shigeki' }, 奥田幸子: { nameEn: 'Okuda Sachiko' },
		安曇恭徳: { nameEn: 'Azumi Yasunori' }, 宮田久子: { nameEn: 'Miyata Hisako' },
		小川早苗: { nameEn: 'Ogawa Sanae' }, 小川昌代: { nameEn: 'Ogawa Masayo' },
		小松和弘: { nameEn: 'Komatsu Kazuhiro' }, 小松哲郎: { nameEn: 'Komatsu Tetsurō' },
		岡本朋也: { nameEn: 'Okamoto Tomoya' }, 岡田勇樹: { nameEn: 'Okada Yūki' },
		川上容子: { nameEn: 'Kawakami Yōko' }, 川上恵: { nameEn: 'Kawakami Megumi' },
		平石清隆: { nameEn: 'Hiraishi Kiyotaka' }, 中野巴絵: { nameEn: 'Nakano Tomoe' },
		赤木三兵: { nameEn: 'Akagi Sanpei' }, 高橋慎: { nameEn: 'Takahashi Shin' },
		松島トミ: { nameEn: 'Matsushima Tomi' }, 熊谷カネ: { nameEn: 'Kumagai Kane' },
		沢井トメノ: { nameEn: 'Sawai Tomeno' }, 貝澤とぅるしの: { nameEn: 'Kaizawa Turushino' },
		遠島タネランケ: { nameEn: 'Tōshima Taneranke' }, 鍋澤ねぷき: { nameEn: 'Nabesawa Nepuki' },
		黒川てしめ: { nameEn: 'Kurokawa Teshime' }, 平賀サダ: { nameEn: 'Hiraga Sada' },
		太田カムㇱオッカイ: { nameEn: 'Ōta Kamus Okkay' },
		李志恒: { nameEn: 'Yi Chi-hang' }, 馬長城: { nameEn: 'Ma Changcheng' },
		徳冨圭: { nameEn: 'Tokutomi Kei' }, 成田英敏: { nameEn: 'Narita Hidetoshi' },
		押野朱美: { nameEn: 'Oshino Akemi', researchmap: 'akemi6oshino' }, 押野里架: { nameEn: 'Oshino Rika' },
		早坂駿: { nameEn: 'Hayasaka Shun' }, 木村多栄子: { nameEn: 'Kimura Taeko' },
		木村梨乃: { nameEn: 'Kimura Rino' }, 松本成美: { nameEn: 'Matsumoto Narumi' },
		横山裕之: { nameEn: 'Yokoyama Hiroyuki' }, 浜田隆史: { nameEn: 'Hamada Takashi' },
		澤井政敏: { nameEn: 'Sawai Masatoshi' }, 田澤崇: { nameEn: 'Tazawa Takashi' },
		相原典明: { nameEn: 'Aihara Noriaki' }, 神崎雅好: { nameEn: 'Kanzaki Masayoshi' },
		秋辺日出男: { nameEn: 'Akibe Hideo' }, 稲垣克彦: { nameEn: 'Inagaki Katsuhiko' },
		米澤諒: { nameEn: 'Yonezawa Ryō' }, 米田儀行: { nameEn: 'Yoneda Noriyuki' },
		菅原勝吉: { nameEn: 'Sugawara Katsukichi' }, 菅原勝良: { nameEn: 'Sugawara Katsuyoshi' },
		菅野由布子: { nameEn: 'Kanno Yūko' }, 葛野大喜: { nameEn: 'Kuzuno Daiki' },
		豊川容子: { nameEn: 'Toyokawa Yōko' }, 貝澤美和子: { nameEn: 'Kaizawa Miwako' },
		野本久栄: { nameEn: 'Nomoto Hisae' }, 金澤庄三郎: { nameEn: 'Kanazawa Shōzaburō' },
		鍋沢元蔵: { nameEn: 'Nabesawa Motozō' }, 長濱清蔵: { nameEn: 'Nagahama Seizō' },
		高木喜久恵: { nameEn: 'Takagi Kikue' }, 片山弘子: { nameEn: 'Katayama Hiroko' },
		リッコッペ: { nameEn: 'Rikkoppe' }, ペンレㇰ: { nameEn: 'Penrek' },
		レタンナイ: { nameEn: 'Retannay' }, ケチ: { nameEn: 'Keci' },
		ラリウ: { nameEn: 'Rariw' }, クワンノ: { nameEn: 'Kuwanno' },
		シッチャリ: { nameEn: 'Sicchari' }, ポロナイ: { nameEn: 'Poronay' },
		ステファニー: { nameEn: 'Stephanie' }, 'ポン・フチ': { nameEn: 'Pon Huci' },
		廣澤: { nameEn: 'Hirosawa' }, 松野綾香: { nameEn: 'Matsuno Ayaka' },
		磯部恵津子: { nameEn: 'Isobe Etsuko' },
		'フダー・クラーラ': { nameEn: 'Klára Chudá' },
		'Suga Toshinoru (菅俊仍縷)?': { nameEn: 'Suga Toshinoru' },
		// Batch 8 (2026-06-02): authors from the new collectors (J-STAGE/IRDB/CiNii/
		// Glottolog), each verified against researchmap/CiNii/Wikipedia/J-STAGE. Where
		// a name also appears in katakana, both keys carry the same romaji so the
		// forms merge via the diacritic-folded romaji key in getPerson.
		遠藤匡俊: { nameEn: 'Endō Masatoshi' }, 加藤百一: { nameEn: 'Katō Hyakuichi' },
		藤田護: { nameEn: 'Fujita Mamoru', researchmap: 'mfujita1023' },
		大喜多紀明: { nameEn: 'Ōkita Noriaki', researchmap: 'utari' }, オオギタノリアキ: { nameEn: 'Ōkita Noriaki' },
		徳田貞一: { nameEn: 'Tokuda Sadakazu' }, 上野昌之: { nameEn: 'Ueno Masayuki' },
		美山治: { nameEn: 'Miyama Osamu' }, 河野廣道: { nameEn: 'Kōno Hiromichi' },
		佐藤昌彦: { nameEn: 'Satō Masahiko' },
		石田收藏: { nameEn: 'Ishida Shūzō' }, 石田収藏: { nameEn: 'Ishida Shūzō' },
		渡辺仁: { nameEn: 'Watanabe Hitoshi' }, 佐々木史郎: { nameEn: 'Sasaki Shirō' },
		新岡武彦: { nameEn: 'Niioka Takehiko' }, 桑林賢治: { nameEn: 'Kuwabayashi Kenji' },
		八幡巴絵: { nameEn: 'Yahata Tomoe' }, 錦谷禎: { nameEn: 'Nishikiya Tadashi' },
		知里眞志保: { nameEn: 'Chiri Mashiho' }, 藤本英夫: { nameEn: 'Fujimoto Hideo' },
		石川元助: { nameEn: 'Ishikawa Motosuke' }, 百瀬響: { nameEn: 'Momose Hibiki' },
		杉山壽榮男: { nameEn: 'Sugiyama Sueo' },
		松名隆: { nameEn: 'Matsuna Takashi' }, マツナタカシ: { nameEn: 'Matsuna Takashi' },
		小野米一: { nameEn: 'Ono Yoneichi' },
		板橋義三: { nameEn: 'Itabashi Yoshizō' }, イタバシヨシゾウ: { nameEn: 'Itabashi Yoshizō' },
		津曲敏郎: { nameEn: 'Tsumagari Toshirō' }, ヌルミユッシ: { nameEn: 'Jussi Nurmi' },
		煎本孝: { nameEn: 'Irimoto Takashi' }, 馬場裕美: { nameEn: 'Baba Yumi' },
		關政則: { nameEn: 'Seki Masanori' }, 関政則: { nameEn: 'Seki Masanori' },
		大垣直明: { nameEn: 'Ōgaki Naoaki' },
		カガミアキカツ: { nameEn: 'Kagami Akikatsu' }, 鏡味明克: { nameEn: 'Kagami Akikatsu' },
		北原モコットゥナシ: { nameEn: 'Kitahara Mokottunas' },
		小林孝二: { nameEn: 'Kobayashi Kōji' }, 岩澤孝子: { nameEn: 'Iwasawa Takako' },
		古川恭子: { nameEn: 'Furukawa Kyōko' }, 笹倉いる美: { nameEn: 'Sasakura Irumi' },
		村崎恭子: { nameEn: 'Murasaki Kyōko' }, ムラサキキョウコ: { nameEn: 'Murasaki Kyōko' },
		竹ケ原幸朗: { nameEn: 'Takegahara Yukio' }, 小浜基次: { nameEn: 'Kohama Mototsugu' },
		新井かおり: { nameEn: 'Arai Kaori' }, 小片保: { nameEn: 'Ogata Tamotsu' },
		// Researchers discovered + verified via researchmap (2026-06-02).
		落合いずみ: { nameEn: 'Ochiai Izumi', researchmap: 'iii' },
		甲地利恵: { nameEn: 'Kōchi Rie', researchmap: 'read0131605' },
		岸本宜久: { nameEn: 'Kishimoto Yoshihisa', researchmap: 'ksmtyshs' },
		大谷洋一: { nameEn: 'Ōtani Yōichi', researchmap: 'read0131604' },
		井上拓也: { nameEn: 'Inoue Takuya', researchmap: 'takuya_inoue' },
		坂田美奈子: { nameEn: 'Sakata Minako', researchmap: '_retar' },
		内田順子: { nameEn: 'Uchida Junko', researchmap: 'uchida_junko0069' },
		// round 2 (2026-06-02)
		風間伸次郎: { nameEn: 'Kazama Shinjirō', researchmap: 'read0015553' },
		小野有五: { nameEn: 'Ono Yūgo', researchmap: 'read0166431' },
		プタシンスキミハウ: { nameEn: 'Michał Ptaszyński', researchmap: 'ptaszynski' },
		桃内佳雄: { nameEn: 'Momouchi Yoshio', researchmap: 'read0021800' },
		荒木健治: { nameEn: 'Araki Kenji', researchmap: 'read0021804' },
		中川奈津子: { nameEn: 'Nakagawa Natsuko', researchmap: 'nakagawanatuko' },
		// round 3 (2026-06-22): verified via api.researchmap.jp (NLP/ASR + revitalization + historical-comparative)
		// Nowakowski keyed by canon (see PERSON_ALIASES/PERSON_CANON 'nowakowski-karol')
		'nowakowski-karol': { nameEn: 'Nowakowski Karol', researchmap: 'nowakowski' },
		上野昌之: { nameEn: 'Ueno Masayuki', researchmap: 'lukemasyk' },
		板橋義三: { nameEn: 'Itabashi Yoshizo', researchmap: 'read0171971' },
		// Batch 9 (2026-06-03): web-verified (researchmap/CiNii/NDL/KAKEN/Wikipedia)
		金成まつ: { nameEn: 'Kannari Matsu' }, 'アンナ・ブガエワ': { nameEn: 'Anna Bugaeva' },
		'ヌルミ・ユッシ': { nameEn: 'Jussi Nurmi' }, 齋藤玲子: { nameEn: 'Saito Reiko' },
		姉帯正樹: { nameEn: 'Anetai Masaki' }, 安田節彦: { nameEn: 'Yasuda Setsuhiko' },
		谷本晃久: { nameEn: 'Tanimoto Akihisa' }, 関口由彦: { nameEn: 'Sekiguchi Yoshihiko' },
		出利葉浩司: { nameEn: 'Deriha Kōji' }, 内田祐一: { nameEn: 'Uchida Yūichi' },
		水島未記: { nameEn: 'Mizushima Miki' }, 荻原真子: { nameEn: 'Ogihara Shinko' },
		山本祐弘: { nameEn: 'Yamamoto Yūkō' }, 榎森進: { nameEn: 'Emori Susumu' },
		関根達人: { nameEn: 'Sekine Tatsuhito' }, 矢崎春菜: { nameEn: 'Yazaki Haruna' },
		計良光範: { nameEn: 'Keira Mitsunori' }, 清野春樹: { nameEn: 'Seino Haruki' },
		福岡イト子: { nameEn: 'Fukuoka Itoko' }, 因幡勝雄: { nameEn: 'Inaba Katsuo' },
		金谷栄二郎: { nameEn: 'Kanaya Eijirō' }, 篠原智花: { nameEn: 'Shinohara Chika' },
		田中聖子: { nameEn: 'Tanaka Satoko' }, 蓮池悦子: { nameEn: 'Hasuike Etsuko' },
		志賀雪湖: { nameEn: 'Shiga Setsuko' }, 小笠原小夜: { nameEn: 'Ogasawara Sayo' },
		'M.M.ドブロトゥヴォールスキー': { nameEn: 'M. M. Dobrotvorsky' },
		谷地田未緒: { nameEn: 'Yachita Mio' }, 前正七生: { nameEn: 'Mae Masanao' },
		村木美幸: { nameEn: 'Muraki Miyuki' }, 加藤克: { nameEn: 'Katō Masaru' },
		伊藤裕満: { nameEn: 'Itō Hiromitsu' }, 石田久大: { nameEn: 'Ishida Hisao' },
		'佐藤ロスベアグナナ': { nameEn: 'Nana Sato-Rossberg' }, 高橋規: { nameEn: 'Takahashi Nori' },
		荒木田家寿: { nameEn: 'Arakida Iehisa' }, 渡邊香織: { nameEn: 'Watanabe Kaori' },
		西山史真子: { nameEn: 'Nishiyama Shimako' }, 萱野茂文: { nameEn: 'Kayano Shigeru' },
		山路広明: { nameEn: 'Yamaji Hiroaki' }, 川上勇治: { nameEn: 'Kawakami Yūji' },
		及川明彦: { nameEn: 'Oikawa Akihiko' }, 鈴木隆一: { nameEn: 'Suzuki Ryūichi' },
		永田良茂: { nameEn: 'Nagata Yoshishige' },
		廣田徹: { nameEn: 'Hirota Tōru' }, 長尾優花: { nameEn: 'Nagao Yuka' },
		斎藤博之: { nameEn: 'Saitō Hiroyuki' },
		// user-confirmed readings (2026-06-03)
		伊藤静致: { nameEn: 'Itō Seichi' }, 扇谷昌康: { nameEn: 'Ōgiya Masayasu' },
		手塚順孝: { nameEn: 'Tezuka Yoritaka' }, 木戸調: { nameEn: 'Kido Shirabe' }
	};

// Japanese personal names that arrived without the conventional space between
// surname and given name. Curated (not a 2+2 guess) because surnames vary in
// length (e.g. 越前谷, 金田一) and the set also contains Chinese names and
// single katakana Ainu names that must be left untouched.
export const NAME_SPACING: Record<string, string> = {
	岸本宜久: '岸本 宜久',
	吉川佳見: '吉川 佳見',
	丹菊逸治: '丹菊 逸治',
	吉田恵理佳: '吉田 恵理佳',
	越前谷博: '越前谷 博',
	阪口諒: '阪口 諒',
	安岡孝一: '安岡 孝一',
	安岡素子: '安岡 素子',
	高橋靖以: '高橋 靖以',
	奥田統己: '奥田 統己',
	小林美紀: '小林 美紀',
	山口伸樹: '山口 伸樹',
	加藤大樹: '加藤 大樹',
	村崎恭子: '村崎 恭子',
	井筒勝信: '井筒 勝信',
	安曇恭徳: '安曇 恭徳',
	桃内佳雄: '桃内 佳雄',
	板橋義三: '板橋 義三',
	田村雅史: '田村 雅史',
	吉本裕子: '吉本 裕子',
	遠藤志保: '遠藤 志保',
	// kanji extracted from "Romaji (Kanji)" historical-author strings
	和田文治郎: '和田 文治郎',
	阿部長三郎: '阿部 長三郎',
	板倉源次郎: '板倉 源次郎',
	松宮観山: '松宮 観山',
	上原熊次郎: '上原 熊次郎',
	寺島良安: '寺島 良安',
	林子平: '林 子平',
	最上徳内: '最上 徳内',
	山辺安之助: '山辺 安之助',
	金田一京助: '金田一 京助',
	// Chinese personal names (surname + given)
	于拙: '于 拙',
	馬長城: '馬 長城'
};

export function canonicalSlugFor(display: string): string | null {
	const forms = new Set<string>();
	const add = (s: string) => {
		const t = s.trim();
		if (t) forms.add(t);
	};
	add(display);
	const bare = stripParens(display);
	add(bare);
	const m = bare.match(/^([^,]+),\s*(.+)$/); // "Last, First"
	if (m) {
		add(m[1].trim()); // bare "Last"
		add(`${m[2].trim()} ${m[1].trim()}`); // "First Last"
	}
	// A 2-token Latin name → also try the swapped order. OpenAlex/Crossref emit
	// "Given Surname" while the aliases use "Surname Given", so this is what lets
	// e.g. "Hiroshi Nakagawa" resolve to the same canon as 中川裕.
	const toks = bare.split(/\s+/).filter(Boolean);
	if (toks.length === 2 && !KANA_KANJI.test(bare)) add(`${toks[1]} ${toks[0]}`);
	for (const f of forms) if (PERSON_ALIASES[f]) return PERSON_ALIASES[f];
	// Space- AND diacritic-insensitive fallback so "中川裕"="中川 裕" and
	// "Satō Tomomi"="Sato Tomomi" (macron) resolve to the same canon.
	const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
	for (const f of forms) {
		const fc = fold(f);
		for (const [k, v] of Object.entries(PERSON_ALIASES)) {
			if (fold(k) === fc) return v;
		}
	}
	return null;
}

/** Split Japanese multi-author strings on '・' only when every segment is
 *  Han-based (real co-authors), never katakana transliterations like
 *  "アンナ・ブガエワ" (a single foreign name). */
export function splitNakaguro(name: string): string[] {
	if (!name.includes('・')) return [name];
	const segs = name.split('・').map((s) => s.trim());
	return segs.every((s) => /[一-龯]/.test(s)) ? segs : [name];
}

export const KANA_KANJI = /[぀-ヿ㐀-鿿一-鿿々ー〆]/;
export const CYRILLIC = /[Ѐ-ӿ]/;
export const LATIN = /[A-Za-z]/;

/** Tidy a romaji transcription: drop editorial markers and stray punctuation. */
export function cleanRomaji(s: string): string {
	let t = s
		.replace(/\b(ed|rec|comp|trans|tr|eds)\.?\b/gi, ' ')
		.replace(/[?]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const ci = t.indexOf(',');
	if (ci !== -1 && ci === t.lastIndexOf(',')) {
		// "Surname, Given" is already surname-first → just drop the comma.
		return `${t.slice(0, ci).trim()} ${t.slice(ci + 1).trim()}`.trim();
	}
	// No comma: source romaji is given-surname; flip a clean 2-token name to the
	// surname-first convention used elsewhere (Kindaichi Kyosuke).
	const toks = t.split(' ');
	if (toks.length === 2 && toks.every((w) => /^[A-Za-zÀ-ÿ.'-]+$/.test(w))) {
		t = `${toks[1]} ${toks[0]}`;
	}
	return t;
}

/**
 * Parse a free-form person string into a primary display name + transcription.
 * Rules: a "Romaji (Kanji)" / "Kanji (Romaji)" pair becomes Kanji-primary with
 * the romaji as transcription; "Surname, Given" Latin names flip to "Given
 * Surname"; known surname/given spacing is applied; Latin names transcribe to
 * themselves. Deterministic — readings are never invented.
 */
export function parsePersonName(raw: string): { name: string; nameEn: string | null } {
	const s = raw.trim().replace(/\s+/g, ' ');
	const m = s.match(/^(.*?)\s*[(（]([^)）]+)[)）]\s*$/);
	const main = m ? m[1].trim() : s;
	let paren = m ? m[2].trim() : null;

	let name = s;
	let nameEn: string | null = null;

	// A trailing role marker — "(rec.)", "(ed.)", "（編）" … — is not part of the
	// name; drop it so the base name merges with the person's other appearances.
	if (paren && /^(rec|ed|comp|trans|tr|eds|録音?|編(訳|者|著|纂|輯)?|訳|採録|撰|選|輯|纂|著|校訂)\.?$/i.test(paren)) {
		name = main;
		paren = null;
	} else if (paren && KANA_KANJI.test(paren) && !KANA_KANJI.test(main)) {
		// "Romaji (Kanji)" → Kanji primary, romaji transcription
		name = paren;
		nameEn = cleanRomaji(main);
	} else if (paren && KANA_KANJI.test(main) && LATIN.test(paren) && !KANA_KANJI.test(paren)) {
		// "Kanji (Romaji)" → Kanji primary, romaji transcription
		name = main;
		nameEn = cleanRomaji(paren);
	} else if (paren && CYRILLIC.test(paren) && !KANA_KANJI.test(main)) {
		// "Latin (Cyrillic)" → keep the Latin form as the primary name
		name = main;
		nameEn = main;
	}

	// CJK "姓, 名" (Crossref/OpenAlex export form) → "姓 名" so it merges with the
	// space-separated form already in the DB (中川, 裕 ⇒ 中川 裕).
	if (KANA_KANJI.test(name) && name.includes(',')) {
		name = name.replace(/\s*,\s*/g, ' ').replace(/\s+/g, ' ').trim();
	}

	// A role suffix glued onto a CJK name — "井筒勝信編", "田村すゞ子著", "研究推進機構編集"
	// — is not part of the name. Strip it (only when ≥2 chars remain) so the bare
	// name merges with the person's other appearances (and institutions then match
	// INSTITUTION_RE on the bare org name).
	if (KANA_KANJI.test(name)) {
		const stripped = name
			.replace(/\s*[-‐–—]?\s*\d{0,4}\s*(通事|通辞)$/, '') // "上原熊次郎 -1827 通事"
			.replace(/\s*(編集|編著|編纂|編訳|共編|共著|校訂|監修|採録|口述|編者|著者|編|著|訳|撰|絵|画|写真|構成)$/, '')
			.trim();
		if (stripped.length >= 2 && stripped !== name) name = stripped;
	}

	// "Surname, Given" → "Given Surname" for clean Latin personal names
	if (!KANA_KANJI.test(name)) {
		const ci = name.indexOf(',');
		if (ci !== -1 && ci === name.lastIndexOf(',')) {
			const sur = name.slice(0, ci).trim();
			const giv = name.slice(ci + 1).trim();
			if (sur && giv && !/\b(et al|various|contributors|consortium|compiler)\b|[&/]/i.test(name)) {
				name = `${giv} ${sur}`;
			}
		}
	}

	if (NAME_SPACING[name]) name = NAME_SPACING[name];
	if (!KANA_KANJI.test(name) && !nameEn) nameEn = name;
	return { name, nameEn: nameEn || null };
}

// --- person identity folding (extracted VERBATIM from seed.ts's getPerson) -----
// seed.ts collapses the many name spellings of one scholar/narrator into a single
// person via an in-memory `personByKey` map keyed on FOLD KEYS. The bootstrap DB
// was built from that map, so a re-import must reproduce the SAME fold keys to
// resolve each name form to the person the bootstrap created (Risk A). These pure
// helpers are that fold logic, shared by the DB-backed resolver in entities.ts.

/**
 * Diacritic-folded, ORDER-INSENSITIVE romaji key. "Tomomi Satō", "Sato Tomomi"
 * and the romaji of 佐藤知己 all fold to the same string, so kanji⇄Latin and
 * given/surname-order variants of one person collapse. (seed.ts getPerson's
 * inline `foldRomaji`, byte-for-byte.)
 */
export function foldRomaji(s: string): string {
	return s
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, ' ')
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.sort()
		.join(' ');
}

/** The canonical display + enrichment a name form resolves to. */
export interface PersonDerivation {
	/** parsed display before canon substitution (parsePersonName's `name`) */
	display: string;
	/** canonical slug (alias/canon fold) or null */
	canon: string | null;
	/** final display name — canon form preferred (seed's `pName`) */
	name: string;
	/** romaji / English reading — canon or enrichment preferred (seed's `pNameEn`) */
	nameEn: string | null;
	/** true when nameEn came from a curated canon/enrichment table (not a parse) */
	curatedNameEn: boolean;
	researchmap: string | null;
	wikidata: string | null;
	/** slug to CREATE with on a miss: canon, else readable romaji/display, else hash */
	slug: string;
}

/**
 * Resolve a free-form person string to its canonical display + enrichment + slug.
 * This is seed.ts getPerson's derivation half (everything up to the personByKey
 * lookup), extracted so entities.ts's DB-backed resolver derives byte-identical
 * values. PURE — no DB, no map state.
 */
export function derivePerson(raw: string): PersonDerivation {
	const parsed = parsePersonName(raw);
	const display = parsed.name;
	const canon = canonicalSlugFor(raw.trim()) ?? canonicalSlugFor(display);
	const enrich =
		(canon ? PERSON_ENRICH[canon] : undefined) ??
		PERSON_ENRICH[raw.trim()] ??
		PERSON_ENRICH[stripParens(display)] ??
		PERSON_ENRICH[stripParens(display).replace(/\s+/g, '')] ??
		PERSON_ENRICH[stripParens(raw.trim()).replace(/\s+/g, '')];
	const c = canon ? PERSON_CANON[canon] : undefined;
	const name = c ? c.name : display;
	const curatedNameEn = Boolean(enrich?.nameEn || c?.nameEn);
	const nameEn: string | null =
		enrich?.nameEn ?? (c ? (c.nameEn ?? (hasCJK(c.name) ? null : c.name)) : parsed.nameEn);
	const researchmap: string | null = enrich?.researchmap ?? null;
	const wikidata: string | null = enrich?.wikidata ?? null;
	const slug = canon
		? canon
		: slugify(stripParens(display)) || (nameEn ? slugify(nameEn) : '') || `p-${djb2(display)}`;
	return { display, canon, name, nameEn, curatedNameEn, researchmap, wikidata, slug };
}

/**
 * The fold keys a person is indexed under, in RESOLUTION PRIORITY order:
 * canonical slug → EXACT despaced kanji / alnum Latin → diacritic-folded romaji.
 * seed's getPerson selected ONE primary key from the ladder canon > romaji >
 * despaced-kanji (plus a secondary romaji index); the DB-backed resolver registers
 * a person under ALL of these and probes an incoming form's keys in order, so every
 * form seed folded into a person still resolves to it — INCLUDING names whose
 * romaji was backfilled after the bootstrap. Such a backfill hands two variant-kanji
 * near-duplicates (e.g. 金澤 vs 金沢, same folded romaji) a SHARED romaji key that
 * seed never had; probing the exact despaced-kanji key BEFORE the folded romaji lets
 * an exact-kanji form land on its own row rather than the wrong twin, matching the
 * bootstrap join. (For a canon / single-identity person every key resolves to the
 * same id, so this order only ever disambiguates such pre-existing twins.)
 */
export function personFoldKeys(d: {
	canon: string | null;
	name: string;
	nameEn: string | null;
}): string[] {
	const keys: string[] = [];
	if (d.canon) keys.push(`canon:${d.canon}`);
	if (KANA_KANJI.test(d.name)) {
		const k = d.name.replace(/\s+/g, '');
		if (k) keys.push(k);
	} else {
		const k = d.name.toLowerCase().replace(/[^a-z0-9]/g, '');
		if (k) keys.push(k);
	}
	if (d.nameEn && !KANA_KANJI.test(d.nameEn)) {
		const r = foldRomaji(d.nameEn);
		if (r) keys.push(`r:${r}`);
	}
	return keys;
}

/** Slugs that are CANONICAL person identities (alias targets / canon-table keys),
 *  so a bootstrapped person's canon can be recovered from its stored slug. */
export const PERSON_CANON_SLUGS: ReadonlySet<string> = new Set<string>([
	...Object.keys(PERSON_CANON),
	...Object.values(PERSON_ALIASES)
]);

// Topical / genre tags derived from a source's title (+ type/dialect). Matched
// as a keyword sweep in attachTags — a source can carry several. Kept high-
// precision so the tag facet is meaningful (NOT a catch-all: academic records
// no longer force a blanket "grammar" tag).
export const TAG_DEFS: { slug: string; name: string; nameEn: string; category: string; match: RegExp }[] = [
	{ slug: 'placenames', name: '地名', nameEn: 'Place names', category: 'topic', match: /地名|placename|place ?names?|toponym|hydronym|river names?|\bchimei\b|geographic(al)? names?/i },
	{ slug: 'phonology', name: '音韻・音声', nameEn: 'Phonology & phonetics', category: 'topic', match: /音韻|音声|アクセント|韻律|声調|phonolog|phonet|accent|prosod|\bvowel|consonant|syllable|moraic|pitch|intonation|phonem|epenthesis/i },
	{ slug: 'grammar', name: '文法・統語', nameEn: 'Grammar & syntax', category: 'topic', match: /文法|構文|統語|grammar|syntax|morpholog|\bverb\b|動詞|名詞|助詞|人称|valency|結合価|aspect|アスペクト|使役|受動|応用|applicative|incorporation|抱合|証拠性|evidential|noun phrase|clitic|nominaliz|relative clause|transitiv|intransitiv|causativ|passive|case marking|word order|grammatical|syntactic|morphosyntax|copula|demonstrativ|interrogativ|imperativ|negation|conjugation|inflection/i },
	{ slug: 'lexicon', name: '語彙・辞典', nameEn: 'Lexicon & dictionaries', category: 'topic', match: /語彙|辞典|辞書|語誌|語源|lexic|vocabular|dictionar|etymolog|word ?list|glossary|lexeme|terminolog|loanword|kinship term|nomenclature|\bjiten\b/i },
	{ slug: 'dialectology', name: '方言', nameEn: 'Dialectology', category: 'topic', match: /方言|dialect/i },
	{ slug: 'comparative', name: '比較・系統', nameEn: 'Comparative & genealogy', category: 'topic', match: /比較|系統|借用|comparative|swadesh|abvd|cognate|proto|loanword|genealog|nivkh|nivx|austronesian|internal reconstruction|language contact|typolog/i },
	{ slug: 'revitalization', name: '復興・教育', nameEn: 'Revitalization & education', category: 'topic', match: /復興|再生|継承|教育|学習|教材|revital|revival|reclamation|heritage language|learner|language nest|endangered language|language education|language teaching/i },
	{ slug: 'oral-literature', name: '口承文芸', nameEn: 'Oral literature', category: 'genre', match: /口承|口頭文芸|oral (literature|narrative|tradition|poetry)|散文説話|韻文|folklore|verbal art|narrative tradition/i },
	{ slug: 'yukar', name: 'ユカㇻ・叙事詩', nameEn: 'Yukar (heroic epic)', category: 'genre', match: /ユカ[ㇻラ]|ユーカラ|\byukar|英雄叙事詩|叙事詩|サコ[ロㇿ]ペ|sakorpe/i },
	{ slug: 'kamuy-yukar', name: '神謡', nameEn: 'Kamuy-yukar (god songs)', category: 'genre', match: /神謡|カムイ.?ユカ|kamuy.?yukar|オイナ|\boina\b|聖伝/i },
	{ slug: 'folktale', name: '昔話・散文説話', nameEn: 'Folktale / prose tale', category: 'genre', match: /昔話|民譚|民話|説話|folktale|uwepeker|ウエペケ|ウウェペケ|トゥイタ|tuyta/i },
	{ slug: 'song', name: '歌謡・ウポポ', nameEn: 'Song', category: 'genre', match: /ウポポ|upopo|リムセ|rimse|歌謡|子守歌|イヨンルイカ|iyonruyka|love.?song|歌曲/i },
	{ slug: 'conversation', name: '会話', nameEn: 'Conversation', category: 'genre', match: /会話|conversation|phrasebook/i },
	{ slug: 'religious-text', name: '宗教テキスト', nameEn: 'Religious text', category: 'genre', match: /聖書|bible|gospel|新約|讃美歌/i },
	// --- language technology (言語技術) — NLP/AI methods, models & resources. A
	// distinct dimension from linguistic subfields: an Ainu LLM/OCR/MT paper or a
	// Hugging Face model belongs here. Model-name patterns (gpt2/mt5/deberta/
	// speecht5…) are matched because HF records have only a terse model name as title.
	{ slug: 'nlp', name: '自然言語処理', nameEn: 'Natural language processing', category: 'technology', match: /自然言語処理|natural language processing|\bNLP\b|computational linguistic|計算言語学|形態素解析|universal dependenc|言語資源|language resource|人工知能|\bAI\b|機械学習|machine learning|深層学習|deep learning|ニューラルネット|neural network/i },
	{ slug: 'ocr', name: '文字認識（OCR）', nameEn: 'OCR (text recognition)', category: 'technology', match: /\bOCR\b|文字認識|光学文字/i },
	{ slug: 'machine-translation', name: '機械翻訳', nameEn: 'Machine translation', category: 'technology', match: /機械翻訳|machine translation|neural machine translation|\bNMT\b|統計的機械翻訳|ニューラル.{0,3}翻訳|翻訳システム|翻訳モデル|translation[ _]model|ainutrans|ainu.?2.?japanese/i },
	{ slug: 'speech-recognition', name: '音声認識', nameEn: 'Speech recognition', category: 'technology', match: /音声認識|speech recognition|\bASR\b|end.to.end speech/i },
	{ slug: 'speech-synthesis', name: '音声合成', nameEn: 'Speech synthesis', category: 'technology', match: /音声合成|text.to.speech|\bTTS\b|speecht5/i },
	{ slug: 'language-model', name: '言語モデル', nameEn: 'Language model', category: 'technology', match: /言語モデル|large language model|大規模言語モデル|\bLLM\b|\bGPT\b|gpt-?2|\bBERT\b|roberta|deberta|\bm?t5\b|byt5|事前学習|pretrained|transformer/i }
];

export const INSTITUTION_RE = /協会|センター|委員会|大学|高校|高等学校|研究所|博物館|教育委員会|学会|財団|機構|振興|協議会|連合会|グループ|製作委員会|教育庁|学習部|文化課|館$|会$|編集部|研究会|研究部|郷土研究|郷土史|郷土資料|郷土|資料室|室$|課$|局|署|庁|事務所|支庁|役場|管理署|クラブ|プロジェクト|実行委|刊行会|出版|書店|書房|文庫|^北海道$|^樺太$|Museum|University|Institute|Association|Foundation|Center|Society|Committee|Club|Project|Bureau|Office|Agency|Council/i;
// Placeholder/garbage "author" tokens that aren't people — a strict prerequisite
// for promoting low-frequency authors to person entities. Anchored to whole-field
// matches so it never strips a substring of a real name.
export const GARBAGE_WORDS_RE = /^(compilation|various|unknown|anon(ymous)?|n\.?d\.?|s\.?n\.?|et al\.?|ほか|他|など|複数|諸氏|有志|aynumosir|著者不明|不明|無記名|collective|staff|editors?|compilers?|編集|編著|編纂|編訳|共編|共著|校訂|監修|採録|口述|編者|著者|編|著|訳|撰|監訳|訳注|校注|解説)$/i;
export function isGarbageName(raw: string): boolean {
	const n = stripParens(raw).trim();
	if (!n) return true;
	if (GARBAGE_WORDS_RE.test(n)) return true;
	if (/[「」『』]/.test(n)) return true; // bracket-quoted org names (「環太平洋の言語」…)
	if (/^[\d\s.,;·・]+$/.test(n)) return true; // pure numeric/punct
	if (!/[A-Za-z]/.test(n) && [...n].length === 1) return true; // lone CJK character
	if (/^[A-Za-z]/.test(n) && n.split(/\s+/).every((t) => t.replace(/\.$/, '').length <= 1)) return true; // initials only
	return false;
}
export function simplePersonKey(name: string): string {
	return stripParens(name).replace(/[\s　,，、.．]+/g, '').trim();
}
export function authorParts(author: string): string[] {
	return author
		.split(/\s*[&;|｜/／]\s*|、|，|\s+and\s+/)
		.flatMap(splitNakaguro)
		.map((s) => s.trim())
		.filter(Boolean);
}

// Prepare an academic title for geo-subject matching: strip institutional /
// publisher compounds whose embedded place-name (esp. 北海道) would otherwise
// register as a spurious geographic pin (北海道大学・北海道立図書館・樺太庁…).
export function geoSubjectText(title: string | null | undefined): string {
	if (!title) return '';
	return title
		.replace(/北海道(大学|教育大学|立[^\s、。，]*|庁|博物館|新聞社?|開拓記念館|開拓使|ウタリ協会)/g, '')
		.replace(/樺太庁/g, '');
}

export interface CatalogEntry {
	source_dir: string;
	title: string;
	title_en?: string;
	type: string;
	author?: string;
	year?: string;
	dialect?: string;
	rows?: number;
	license?: string;
}

export function langsForDict(e: CatalogEntry): { languages: string[]; scripts: string[] } {
	const hay = `${e.author ?? ''} ${e.title_en ?? ''} ${e.source_dir} ${e.dialect ?? ''}`;
	const languages = new Set<string>(['ain']);
	const scripts = new Set<string>();
	if (/russ|dobrotvor|akulov|lexicons|voznesen|golovnin|вознесен/i.test(hay)) {
		languages.add('rus');
		scripts.add('cyrl');
	}
	if (/english|batchelor|shibatani|vovin|asjp|northeuralex|abvd|swadesh|valpal|bugaeva/i.test(hay)) {
		languages.add('eng');
		scripts.add('latn');
	}
	if (e.type === 'old-document') {
		languages.add('jpn');
		scripts.add('kana');
		scripts.add('kanji');
	} else if (hasCJK(e.title) || /kanazawa|chiri|kayano|tamura|nakagawa|ota|hattori|kindaichi/i.test(hay)) {
		languages.add('jpn');
		scripts.add('kana');
	}
	if (scripts.size === 0) scripts.add('latn');
	if (e.dialect && /祖アイヌ|proto/i.test(e.dialect)) scripts.add('latn');
	return { languages: [...languages], scripts: [...scripts] };
}

// Hand corrections for catalog entries the heuristic langsForDict / catalog year
// gets wrong, verified against the actual documents. Keyed by source_dir (slug
// stays stable — it derives from source_dir, not from year/language).
export const CATALOG_OVERRIDES: Record<
	string,
	{ languages?: string[]; scripts?: string[]; year?: string; author?: string }
> = {
	// 李志恒『漂舟録』— Joseon Korean castaway's account, written in Literary Chinese (漢文), NOT Japanese
	'1696_Anon_Hyoshuroku': { languages: ['ain', 'lzh'], scripts: ['kanji'], author: '李志恒' },
	// Steller's Kuril-Ainu vocabulary — the original is German (no English material on Ainu predates Cook, c.1779)
	'1743_Steller_Kuril-Ainu-Vocabulary': { languages: ['ain', 'deu'], scripts: ['latn'] },
	// 黙魯庵漫録 — NDL Search dates it 1930–1933 (catalog had 18XX)
	'18XX_Anon_Mokuroan-Manroku': { year: '1930-1933' },
	// De Angelis (Italian Jesuit) — original "Relazione del regno di Yezo" is Italian, not Japanese
	'1621_DeAngelis_Second-Ezo-Report': { languages: ['ain', 'ita'], scripts: ['latn'] },
	// Krasheninnikov 1738 "Vocabularium: Latine-Curilice-…" — Latin-glossed Kuril Ainu wordlist
	'1738_Krasheninnikov_Latino-Curilice': { languages: ['ain', 'lat'], scripts: ['latn'] }
};

