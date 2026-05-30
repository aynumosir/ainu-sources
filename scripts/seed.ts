/**
 * Seed the アイヌ語文献資料データベース from the sibling data repositories:
 *   - ../ainu-dictionaries/catalog.json   (dictionaries, wordlists, old documents)
 *   - ../ainu-grammar/{books,articles}     (secondary research literature)
 *   - ../ainu-corpora/data.jsonl           (aligned Ainu/Japanese corpus texts)
 *
 * Run:  bun scripts/seed.ts        (reads DATABASE_URL from .env)
 *
 * Idempotent: wipes the domain tables (NOT the auth tables) and rebuilds.
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as schema from '../src/lib/server/db/schema';

const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(import.meta.dir, '../..');
const DICT_DIR = path.join(AINU_ROOT, 'ainu-dictionaries');
const GRAMMAR_DIR = path.join(AINU_ROOT, 'ainu-grammar');
const CORPUS_FILE = path.join(AINU_ROOT, 'ainu-corpora', 'data.jsonl');

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const client = createClient({
	url,
	authToken: process.env.DATABASE_AUTH_TOKEN || undefined
});
const db = drizzle(client, { schema });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const uuid = () => crypto.randomUUID();

function djb2(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

function slugify(input: string): string {
	return input
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/['’"()]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.replace(/-{2,}/g, '-');
}

function stripParens(s: string): string {
	return s.replace(/[(（][^)）]*[)）]/g, '').trim();
}

const hasCJK = (s: string) => /[぀-ヿ㐀-鿿豈-﫿]/.test(s);

/** Parse a verbatim year string into numeric start/end + certainty. */
function parseYear(raw: string | null | undefined): {
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
interface GazEntry {
	slug: string;
	name: string;
	nameEn: string;
	kind: string;
	region: string;
	lat: number;
	lng: number;
}
const GAZETTEER: { match: RegExp; place: GazEntry }[] = [
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
	{ match: /樺太|サハリン|sakhalin|エンチウ/i, place: { slug: 'sakhalin', name: '樺太', nameEn: 'Sakhalin', kind: 'region', region: 'sakhalin', lat: 49.5, lng: 142.5 } },
	{ match: /千島|クリル|kuril/i, place: { slug: 'kuril', name: '千島', nameEn: 'Kuril Islands', kind: 'island', region: 'kuril', lat: 45.5, lng: 149.0 } },
	{ match: /北海道|hokkaido/i, place: { slug: 'hokkaido', name: '北海道', nameEn: 'Hokkaidō', kind: 'region', region: 'hokkaido', lat: 43.4, lng: 142.8 } }
];

function regionFor(dialect: string): string {
	if (!dialect) return '';
	const macros = new Set<string>();
	if (/樺太|サハリン|sakhalin|エンチウ/i.test(dialect)) macros.add('sakhalin');
	if (/千島|色丹|クリル|kuril|shikotan/i.test(dialect)) macros.add('kuril');
	if (/祖アイヌ|proto/i.test(dialect)) macros.add('proto');
	if (/北海道|沙流|千歳|様似|旭川|浦河|鵡川|幌別|静内|十勝|石狩|釧路|hokkaido|saru|chitose|samani|asahikawa|urakawa|mukawa|horobetsu|shizunai|tokachi|ishikari|kushiro/i.test(dialect))
		macros.add('hokkaido');
	if (macros.size === 0) return '';
	if (macros.size === 1) return [...macros][0];
	return 'other';
}

function placesFor(dialect: string): GazEntry[] {
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
	// Drop the broad "hokkaido" pin only when a *specific* Hokkaido place matched;
	// keep it for bi-regional sources (e.g. 北海道・樺太) so the Sakhalin link stays too.
	const hasSpecificHokkaido = found.some((p) => p.region === 'hokkaido' && p.slug !== 'hokkaido');
	return hasSpecificHokkaido ? found.filter((p) => p.slug !== 'hokkaido') : found;
}

// --- institutions keyed by URI host ---
interface InstEntry {
	slug: string;
	name: string;
	nameEn: string;
	country: string;
	city: string;
	lat: number;
	lng: number;
	url: string;
}
const INSTITUTIONS: Record<string, InstEntry> = {
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

function linkTypeFor(host: string): string {
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
const PERSON_ALIASES: Record<string, string> = {
	Tamura: 'tamura-suzuko', 'Tamura, Suzuko': 'tamura-suzuko', 'Tamura Suzuko': 'tamura-suzuko', 'Suzuko Tamura': 'tamura-suzuko', 田村すゞ子: 'tamura-suzuko', 田村すず子: 'tamura-suzuko', 田村寿々子: 'tamura-suzuko',
	// née Fukuda — her maiden name appears on early work
	福田すず子: 'tamura-suzuko', 福田すゞ子: 'tamura-suzuko', 'Fukuda Suzuko': 'tamura-suzuko', 'Suzuko Fukuda': 'tamura-suzuko', 'Fukuda, Suzuko': 'tamura-suzuko',
	Nakagawa: 'nakagawa-hiroshi', 'Nakagawa, Hiroshi': 'nakagawa-hiroshi', 'Nakagawa Hiroshi': 'nakagawa-hiroshi', 中川裕: 'nakagawa-hiroshi',
	Kayano: 'kayano-shigeru', 'Kayano, Shigeru': 'kayano-shigeru', 'Kayano Shigeru': 'kayano-shigeru', 萱野茂: 'kayano-shigeru',
	Sato: 'sato-tomomi', 'Sato, Tomomi': 'sato-tomomi', 'Sato Tomomi': 'sato-tomomi', 佐藤知己: 'sato-tomomi',
	Bugaeva: 'bugaeva-anna', 'Bugaeva, Anna': 'bugaeva-anna', 'Bugaeva Anna': 'bugaeva-anna', 'Anna Bugaeva': 'bugaeva-anna', 'ブガエワ・アンナ': 'bugaeva-anna', ブガエワアンナ: 'bugaeva-anna',
	Ijas: 'ijas-silja', Silja: 'ijas-silja', 'Ijas Silja': 'ijas-silja', 'Silja Ijas': 'ijas-silja', 'Ijäs, Silja': 'ijas-silja',
	Chiri: 'chiri-mashiho', 'Chiri, Mashiho': 'chiri-mashiho', 'Chiri Mashiho': 'chiri-mashiho', 知里真志保: 'chiri-mashiho',
	'Chiri, Yukie': 'chiri-yukie', 'Chiri Yukie': 'chiri-yukie', 知里幸恵: 'chiri-yukie', 知里幸惠: 'chiri-yukie',
	Kindaichi: 'kindaichi-kyosuke', 'Kindaichi, Kyosuke': 'kindaichi-kyosuke', 'Kindaichi Kyosuke': 'kindaichi-kyosuke', 金田一京助: 'kindaichi-kyosuke',
	Hattori: 'hattori-shiro', 'Hattori, Shiro': 'hattori-shiro', 'Hattori Shiro': 'hattori-shiro', 服部四郎: 'hattori-shiro',
	Shibatani: 'shibatani-masayoshi', 'Shibatani, Masayoshi': 'shibatani-masayoshi', 'Shibatani Masayoshi': 'shibatani-masayoshi', 柴谷方良: 'shibatani-masayoshi',
	Kirikae: 'kirikae-hideo', 切替英雄: 'kirikae-hideo',
	Fukazawa: 'fukazawa-mika', 'Fukazawa Mika': 'fukazawa-mika', 深沢美香: 'fukazawa-mika', 深澤美香: 'fukazawa-mika',
	北海道ウタリ協会: 'hokkaido-utari-kyokai'
};
const PERSON_CANON: Record<string, { name: string; nameEn?: string }> = {
	'tamura-suzuko': { name: '田村 すゞ子', nameEn: 'Tamura Suzuko' },
	'nakagawa-hiroshi': { name: '中川 裕', nameEn: 'Nakagawa Hiroshi' },
	'kayano-shigeru': { name: '萱野 茂', nameEn: 'Kayano Shigeru' },
	'sato-tomomi': { name: '佐藤 知己', nameEn: 'Sato Tomomi' },
	'bugaeva-anna': { name: 'Anna Bugaeva' },
	'ijas-silja': { name: 'Ijas Silja' },
	'chiri-mashiho': { name: '知里 真志保', nameEn: 'Chiri Mashiho' },
	'chiri-yukie': { name: '知里 幸恵', nameEn: 'Chiri Yukie' },
	'kindaichi-kyosuke': { name: '金田一 京助', nameEn: 'Kindaichi Kyosuke' },
	'hattori-shiro': { name: '服部 四郎', nameEn: 'Hattori Shiro' },
	'shibatani-masayoshi': { name: 'Shibatani Masayoshi' },
	'kirikae-hideo': { name: '切替 英雄', nameEn: 'Kirikae Hideo' },
	'fukazawa-mika': { name: '深澤 美香', nameEn: 'Fukazawa Mika' },
	'hokkaido-utari-kyokai': { name: '北海道ウタリ協会', nameEn: 'Hokkaido Utari Association' }
};

// Hand-verified enrichment for individuals (esp. Japanese-named researchers whose
// romaji isn't derivable from kanji). Keyed by the exact name as it appears in the
// source data. Values are confirmed against the linked profile — never guessed.
// `researchmap` is the researchmap.jp permalink (the path after the domain).
// Verified against each person's researchmap profile API (kanji + romaji read
// straight from family_name/given_name). Kanji keys are written WITHOUT the
// surname/given space; the lookup is space-insensitive (see getPerson).
const PERSON_ENRICH: Record<string, { nameEn?: string; researchmap?: string; wikidata?: string }> =
	{
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
		'Anna Bugaeva': { researchmap: 'read0144912' },
		// keyed by canonical slug so it applies no matter which name form created the person
		'sato-tomomi': { researchmap: 'ainlingsat' },
		'nakagawa-hiroshi': { researchmap: 'read0064265' },
		'fukazawa-mika': { researchmap: 'mkfk' },
		'bugaeva-anna': { researchmap: 'read0144912' }
	};

// Japanese personal names that arrived without the conventional space between
// surname and given name. Curated (not a 2+2 guess) because surnames vary in
// length (e.g. 越前谷, 金田一) and the set also contains Chinese names and
// single katakana Ainu names that must be left untouched.
const NAME_SPACING: Record<string, string> = {
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

function canonicalSlugFor(display: string): string | null {
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
	for (const f of forms) if (PERSON_ALIASES[f]) return PERSON_ALIASES[f];
	// Space-insensitive fallback so "中川裕" and "中川 裕" resolve to the same canon.
	for (const f of forms) {
		const fc = f.replace(/\s+/g, '');
		for (const [k, v] of Object.entries(PERSON_ALIASES)) {
			if (k.replace(/\s+/g, '') === fc) return v;
		}
	}
	return null;
}

/** Split Japanese multi-author strings on '・' only when every segment is
 *  Han-based (real co-authors), never katakana transliterations like
 *  "アンナ・ブガエワ" (a single foreign name). */
function splitNakaguro(name: string): string[] {
	if (!name.includes('・')) return [name];
	const segs = name.split('・').map((s) => s.trim());
	return segs.every((s) => /[一-龯]/.test(s)) ? segs : [name];
}

// ---------------------------------------------------------------------------
// In-memory accumulators
// ---------------------------------------------------------------------------
interface Row {
	[k: string]: unknown;
}
const sourceRows: Row[] = [];
const linkRows: Row[] = [];
const sourcePersonRows: Row[] = [];
const sourcePlaceRows: Row[] = [];
const sourceInstRows: Row[] = [];
const sourceTagRows: Row[] = [];

const personByKey = new Map<string, string>(); // key → id
const personRows: Row[] = [];
const usedPersonSlugs = new Set<string>();
const placeBySlug = new Map<string, string>();
const placeRows: Row[] = [];
const instBySlug = new Map<string, string>();
const instRows: Row[] = [];
const tagBySlug = new Map<string, string>();
const tagRows: Row[] = [];
const usedSlugs = new Set<string>();

function uniqueSlug(base: string): string {
	let s = base || 'source';
	let n = 1;
	while (usedSlugs.has(s)) {
		n += 1;
		s = `${base}-${n}`;
	}
	usedSlugs.add(s);
	return s;
}

const KANA_KANJI = /[぀-ヿ㐀-鿿一-鿿々ー〆]/;
const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

/** Tidy a romaji transcription: drop editorial markers and stray punctuation. */
function cleanRomaji(s: string): string {
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
function parsePersonName(raw: string): { name: string; nameEn: string | null } {
	const s = raw.trim().replace(/\s+/g, ' ');
	const m = s.match(/^(.*?)\s*[(（]([^)）]+)[)）]\s*$/);
	const main = m ? m[1].trim() : s;
	let paren = m ? m[2].trim() : null;

	let name = s;
	let nameEn: string | null = null;

	// A trailing role marker — "(rec.)", "(ed.)", "（編）" … — is not part of the
	// name; drop it so the base name merges with the person's other appearances.
	if (paren && /^(rec|ed|comp|trans|tr|eds|録音?|編(訳|者)?|訳|採録)\.?$/i.test(paren)) {
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

function getPerson(name: string): string {
	const parsed = parsePersonName(name);
	const display = parsed.name;
	const canon = canonicalSlugFor(name.trim()) ?? canonicalSlugFor(display);
	const key = canon ? `canon:${canon}` : display;
	const existing = personByKey.get(key);
	if (existing) return existing;
	// Hand-verified enrichment (romaji / researchmap / wikidata), matched on either
	// the raw or normalized name.
	// Enrichment lookup: by canonical slug first (most reliable), then by name
	// forms (space-insensitive; kanji keys are stored without spaces).
	const enrich =
		(canon ? PERSON_ENRICH[canon] : undefined) ??
		PERSON_ENRICH[name.trim()] ??
		PERSON_ENRICH[stripParens(display)] ??
		PERSON_ENRICH[stripParens(display).replace(/\s+/g, '')] ??
		PERSON_ENRICH[stripParens(name.trim()).replace(/\s+/g, '')];
	const researchmap: string | null = enrich?.researchmap ?? null;
	const wikidata: string | null = enrich?.wikidata ?? null;

	const id = uuid();
	let slug: string;
	let pName = display;
	let pNameEn: string | null = enrich?.nameEn ?? parsed.nameEn;
	if (canon) {
		slug = canon;
		const c = PERSON_CANON[canon];
		if (c) {
			pName = c.name;
			pNameEn = enrich?.nameEn ?? c.nameEn ?? (hasCJK(c.name) ? null : c.name);
		}
		usedPersonSlugs.add(slug);
	} else {
		// Prefer a readable slug from romaji (incl. enrichment) over a hash.
		const baseSlug =
			slugify(stripParens(display)) || (pNameEn ? slugify(pNameEn) : '') || `p-${djb2(display)}`;
		slug = baseSlug;
		let n = 1;
		while (usedPersonSlugs.has(slug)) {
			n += 1;
			slug = `${baseSlug}-${n}`;
		}
		usedPersonSlugs.add(slug);
	}

	personByKey.set(key, id);
	personRows.push({
		id,
		slug,
		name: pName,
		nameEn: pNameEn,
		nameKana: null,
		nameAin: null,
		researchmap,
		wikidata
	});
	return id;
}

function getPlace(p: GazEntry): string {
	const existing = placeBySlug.get(p.slug);
	if (existing) return existing;
	const id = uuid();
	placeBySlug.set(p.slug, id);
	placeRows.push({
		id,
		slug: p.slug,
		name: p.name,
		nameEn: p.nameEn,
		kind: p.kind,
		region: p.region,
		lat: p.lat,
		lng: p.lng
	});
	return id;
}

function getInstitution(inst: InstEntry): string {
	const existing = instBySlug.get(inst.slug);
	if (existing) return existing;
	const id = uuid();
	instBySlug.set(inst.slug, id);
	instRows.push({
		id,
		slug: inst.slug,
		name: inst.name,
		nameEn: inst.nameEn,
		country: inst.country,
		city: inst.city,
		lat: inst.lat,
		lng: inst.lng,
		url: inst.url
	});
	return id;
}

const TAG_DEFS: { slug: string; name: string; nameEn: string; category: string; match: RegExp }[] = [
	{ slug: 'placenames', name: '地名', nameEn: 'Place names', category: 'topic', match: /地名|placename|toponym/i },
	{ slug: 'conversation', name: '会話', nameEn: 'Conversation', category: 'genre', match: /会話|conversation|phrasebook/i },
	{ slug: 'oral-literature', name: '口承文芸', nameEn: 'Oral literature', category: 'genre', match: /神謡|叙事詩|口承|yukar|yukara|kamuy|epic/i },
	{ slug: 'folktale', name: '昔話・民譚', nameEn: 'Folktale', category: 'genre', match: /昔話|民譚|民話|folktale|uwepeker/i },
	{ slug: 'religious-text', name: '宗教テキスト', nameEn: 'Religious text', category: 'genre', match: /聖書|bible|gospel|新約/i },
	{ slug: 'grammar', name: '文法', nameEn: 'Grammar', category: 'topic', match: /文法|grammar|syntax|morpholog|verb|動詞|助詞|valency|結合価/i },
	{ slug: 'comparative', name: '比較・対照', nameEn: 'Comparative', category: 'topic', match: /比較|comparative|swadesh|abvd|cognate|proto/i }
];

function getTag(def: (typeof TAG_DEFS)[number]): string {
	const existing = tagBySlug.get(def.slug);
	if (existing) return existing;
	const id = uuid();
	tagBySlug.set(def.slug, id);
	tagRows.push({ id, slug: def.slug, name: def.name, nameEn: def.nameEn, category: def.category });
	return id;
}

function attachTags(sourceId: string, ...texts: (string | null | undefined)[]) {
	const hay = texts.filter(Boolean).join(' ');
	for (const def of TAG_DEFS) {
		if (def.match.test(hay)) {
			sourceTagRows.push({ id: uuid(), sourceId, tagId: getTag(def) });
		}
	}
}

function addPersons(sourceId: string, author: string | null | undefined, role = 'author') {
	if (!author) return;
	const cleaned = author.trim();
	if (!cleaned || /^(unknown|anon\.?|anonymous|不明|作者不詳|なし|n\/a)$/i.test(cleaned)) return;
	// Placeholder "authorship" labels are not people — keep them only as the
	// source's free-text author, never as a person entity.
	if (/\b(various|compilation)\b/i.test(cleaned)) return;
	const parts = cleaned
		.split(/\s*[&;]\s*|、|\s+and\s+/)
		.flatMap(splitNakaguro)
		.map((s) => s.trim())
		.filter(Boolean);
	parts.forEach((name, i) => {
		sourcePersonRows.push({ id: uuid(), sourceId, personId: getPerson(name), role, sortOrder: i });
	});
}

function addPlaces(sourceId: string, dialect: string | null | undefined, role = 'dialect') {
	if (!dialect) return;
	for (const p of placesFor(dialect)) {
		sourcePlaceRows.push({ id: uuid(), sourceId, placeId: getPlace(p), role });
	}
}

// ---------------------------------------------------------------------------
// 1) Dictionaries / wordlists / old documents
// ---------------------------------------------------------------------------
interface CatalogEntry {
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

function langsForDict(e: CatalogEntry): { languages: string[]; scripts: string[] } {
	const hay = `${e.author ?? ''} ${e.title_en ?? ''} ${e.source_dir} ${e.dialect ?? ''}`;
	const languages = new Set<string>(['ain']);
	const scripts = new Set<string>();
	if (/russ|dobrotvor|akulov|lexicons|voznesen|golovnin|вознесен/i.test(hay)) {
		languages.add('rus');
		scripts.add('cyrl');
	}
	if (/english|batchelor|shibatani|vovin|asjp|northeuralex|abvd|swadesh|valpal|bugaeva|steller/i.test(hay)) {
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

function seedDictionaries() {
	const catalog: CatalogEntry[] = JSON.parse(fs.readFileSync(path.join(DICT_DIR, 'catalog.json'), 'utf8'));
	for (const e of catalog) {
		const id = uuid();
		const slug = uniqueSlug(slugify(e.source_dir));
		const y = parseYear(e.year);
		const { languages, scripts } = langsForDict(e);
		const dialect = e.dialect || '';
		sourceRows.push({
			id,
			slug,
			title: e.title,
			titleEn: e.title_en ?? null,
			category: 'primary',
			type: e.type,
			author: e.author && !/^unknown$/i.test(e.author) ? e.author : null,
			...y,
			dialect: dialect || null,
			region: regionFor(dialect) || null,
			languages,
			scripts,
			entryCount: e.rows ?? null,
			entryCountLabel: 'entries',
			license: e.license ?? null,
			provenanceRepo: 'ainu-dictionaries',
			provenancePath: e.source_dir,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		addPersons(id, e.author);
		addPlaces(id, dialect);
		attachTags(id, e.title, e.title_en, e.type, dialect);
	}
	return catalog.length;
}

// ---------------------------------------------------------------------------
// 2) Grammar bibliography (books + articles)
// ---------------------------------------------------------------------------
const BOOK_TITLES: Record<string, { title: string; titleEn: string | null }> = {
	'2022_Bugaeva': { title: 'Handbook of the Ainu Language', titleEn: 'Handbook of the Ainu Language' },
	'2008_Sato': { title: 'アイヌ語文法の基礎', titleEn: 'Foundations of Ainu Grammar' },
	'1936_Kindaichi': { title: 'アイヌ語法概説', titleEn: 'An Outline of Ainu Grammar' }
};

function seedGrammar() {
	let count = 0;
	// --- books (directories named YYYY_Author) ---
	const booksDir = path.join(GRAMMAR_DIR, 'books');
	if (fs.existsSync(booksDir)) {
		for (const dir of fs.readdirSync(booksDir)) {
			if (dir === 'ocr' || dir.startsWith('.')) continue;
			const full = path.join(booksDir, dir);
			if (!fs.statSync(full).isDirectory()) continue;
			const m = dir.match(/^(\d{4})_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw] = m;
			const author = authorRaw.replace(/([a-z])([A-Z])/g, '$1 $2');
			const known = BOOK_TITLES[dir];
			const id = uuid();
			const slug = uniqueSlug(slugify(dir));
			sourceRows.push({
				id,
				slug,
				title: known?.title ?? `${author}（${year}）`,
				titleEn: known?.titleEn ?? `${author} (${year})`,
				category: 'secondary',
				type: 'grammar-book',
				author,
				...parseYear(year),
				languages: ['ain'],
				scripts: ['latn'],
				license: null,
				provenanceRepo: 'ainu-grammar',
				provenancePath: `books/${dir}`,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			addPersons(id, author, 'researcher');
			attachTags(id, known?.title, 'grammar');
			count += 1;
		}
	}
	// --- articles (files YYYY_Author_Title.{pdf,ocr,md}) ---
	const artDir = path.join(GRAMMAR_DIR, 'articles');
	if (fs.existsSync(artDir)) {
		const seen = new Set<string>();
		for (const file of fs.readdirSync(artDir)) {
			if (file === 'ocr' || file === 'NAMING.md' || file.startsWith('.')) continue;
			const base = file.replace(/\.(pdf|ocr|md|txt)$/i, '');
			if (seen.has(base)) continue;
			seen.add(base);
			const m = base.match(/^(\d{4})_([^_]+)_(.+)$/);
			if (!m) continue;
			const [, year, authorRaw, titleRaw] = m;
			const author = authorRaw.trim();
			const title = titleRaw.trim();
			const id = uuid();
			const slug = uniqueSlug(`${year}-${slugify(author) || 'x'}-${slugify(title) || djb2(base)}`);
			const isJa = hasCJK(title);
			sourceRows.push({
				id,
				slug,
				title,
				titleEn: isJa ? null : title,
				category: 'secondary',
				type: 'grammar-article',
				author,
				...parseYear(year),
				languages: isJa ? ['ain', 'jpn'] : ['ain', 'eng'],
				scripts: ['latn'],
				license: null,
				provenanceRepo: 'ainu-grammar',
				provenancePath: `articles/${base}`,
				createdAt: new Date(),
				updatedAt: new Date()
			});
			addPersons(id, author, 'researcher');
			attachTags(id, title, 'grammar');
			count += 1;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// 3) Corpus collections (aggregate data.jsonl by collection_lv1)
// ---------------------------------------------------------------------------
const CORPUS_META: Record<string, { slug: string; titleEn: string }> = {
	'アイヌ神謡集': { slug: 'ainu-shinyoshu', titleEn: "Ainu Shin'yōshū (Chiri Yukie)" },
	'アイヌ語訳新約聖書': { slug: 'ainu-new-testament', titleEn: 'Ainu New Testament' },
	'アイヌ語口承文芸コーパス': { slug: 'ninjal-folklore-corpus', titleEn: 'NINJAL Ainu Folklore Corpus' },
	'アイヌ語ラジオ講座テキスト': { slug: 'ainu-radio-course', titleEn: 'Ainu Radio Course Texts' },
	'浅井タケ昔話全集 I, II': { slug: 'asai-take-folktales', titleEn: 'Asai Take Folktale Collection I, II' },
	'トピック別 アイヌ語会話辞典': { slug: 'topical-ainu-conversation-corpus', titleEn: 'Topical Ainu Conversation Dictionary' },
	'アイヌ語鵡川方言日本語‐アイヌ語辞典': { slug: 'mukawa-dialect-dictionary-corpus', titleEn: 'Mukawa Dialect Japanese–Ainu Dictionary' },
	'アイヌ語音声資料': { slug: 'ainu-audio-materials', titleEn: 'Ainu Audio Materials' },
	'ニューエクスプレスプラス アイヌ語': { slug: 'new-express-plus-ainu', titleEn: 'New Express Plus: Ainu' },
	'ニューエクスプレス・スペシャル 日本語の隣人たち I+II': { slug: 'new-express-special-neighbors', titleEn: 'New Express Special: Neighbors of Japanese I+II' },
	'CDエクスプレス アイヌ語': { slug: 'cd-express-ainu', titleEn: 'CD Express: Ainu' },
	'千徳太郎治のピウスツキ宛書簡': { slug: 'sentoku-pilsudski-letters', titleEn: "Sentoku Tarōji's Letters to Piłsudski" },
	'アイヌ語・アイヌ文化研究の課題': { slug: 'chiba-ainu-research-issues', titleEn: 'Issues in Ainu Language & Culture Research (Chiba U.)' },
	'アイヌタイムズ': { slug: 'ainu-times', titleEn: 'Ainu Times' },
	'アイヌ語アーカイブ': { slug: 'nam-ainu-archive', titleEn: 'National Ainu Museum Language Archive' },
	'AA研アイヌ語資料': { slug: 'ilcaa-ainu-materials', titleEn: 'ILCAA Ainu Language Materials' },
	'アイヌ民譚集': { slug: 'ainu-mintanshu', titleEn: 'Ainu Mintanshū (Chiri Mashiho)' },
	'アイヌ口承文芸テキスト集': { slug: 'ainu-oral-literature-texts', titleEn: 'Ainu Oral Literature Text Collection' },
	'アイヌの知恵・ウパㇱクマ1': { slug: 'upaskuma-1', titleEn: 'Ainu Wisdom: Upaskuma 1' },
	'アイヌの知恵・ウパㇱクマ2': { slug: 'upaskuma-2', titleEn: 'Ainu Wisdom: Upaskuma 2' },
	'ウポポイ館内展示': { slug: 'upopoy-exhibits', titleEn: 'Upopoy Exhibition Texts' },
	'エンチウ（樺太アイヌ語）会話入門': { slug: 'enchiw-sakhalin-conversation', titleEn: 'Enchiw (Sakhalin Ainu) Conversation Primer' },
	'アイヌ語復興に関わる諸問題': { slug: 'ainu-revitalization-issues', titleEn: 'Issues in Ainu Language Revitalization' },
	'アイヌ語弁論大会': { slug: 'ainu-speech-contest', titleEn: 'Ainu Language Speech Contest' },
	'長濱清蔵のアイヌ語': { slug: 'nagahama-seizo-ainu', titleEn: "Nagahama Seizō's Ainu" },
	'千葉大学大学院人文公共学府研究プロジェクト報告書': { slug: 'chiba-grad-report', titleEn: 'Chiba University Graduate Research Project Report' },
	'アイヌ語教材テキスト': { slug: 'ainu-teaching-materials', titleEn: 'Ainu Language Teaching Materials' },
	'アコㇿイタㇰ': { slug: 'akor-itak', titleEn: 'Akor Itak ("Our Language") Textbook' },
	'ウポポイ職員インタビュー': { slug: 'upopoy-staff-interviews', titleEn: 'Upopoy Staff Interviews' },
	'カムイユカㇻを聞いてアイヌ語を学ぶ': { slug: 'learning-ainu-through-kamuy-yukar', titleEn: 'Learning Ainu by Listening to Kamuy Yukar' },
	'北海道大学所在地の先住民族に対する敬意の表明': { slug: 'hokudai-indigenous-respect-statement', titleEn: "Statement of Respect for the Indigenous Peoples of Hokkaido University's Location" },
	'北海道立アイヌ民族文化研究センター紀要': { slug: 'hokkaido-ainu-culture-center-bulletin', titleEn: 'Bulletin of the Hokkaido Ainu Culture Research Center' },
	'川上まつ子の伝承': { slug: 'kawakami-matsuko-traditions', titleEn: 'Oral Traditions of Kawakami Matsuko' },
	'平取町アイヌ口承文芸': { slug: 'biratori-ainu-oral-literature', titleEn: 'Biratori Town Ainu Oral Literature' },
	'知里幸恵のウウェペケレ（昔話）': { slug: 'chiri-yukie-uwepeker', titleEn: "Chiri Yukie's Uwepeker (Folktales)" },
	'葛野辰次郎の伝承': { slug: 'kuzuno-tatsujiro-traditions', titleEn: 'Oral Traditions of Kuzuno Tatsujirō' },
	'鍋沢元蔵筆録ノート': { slug: 'nabesawa-motozo-notebooks', titleEn: "Nabesawa Motozō's Transcription Notebooks" }
};

interface CorpusAgg {
	collection: string;
	n: number;
	documents: Set<string>;
	dialects: Set<string>;
	dialectL1: Set<string>;
	recordedYears: number[];
	publishedYears: number[];
	uris: Set<string>;
	authors: Set<string>;
}

async function seedCorpus(): Promise<number> {
	if (!fs.existsSync(CORPUS_FILE)) {
		console.warn(`! corpus file not found at ${CORPUS_FILE} — skipping corpus`);
		return 0;
	}
	const aggs = new Map<string, CorpusAgg>();
	const rl = readline.createInterface({
		input: fs.createReadStream(CORPUS_FILE, 'utf8'),
		crlfDelay: Infinity
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		let rec: Record<string, unknown>;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const collection = (rec.collection_lv1 as string) || '';
		if (!collection || collection === 'null') continue;
		let a = aggs.get(collection);
		if (!a) {
			a = {
				collection,
				n: 0,
				documents: new Set(),
				dialects: new Set(),
				dialectL1: new Set(),
				recordedYears: [],
				publishedYears: [],
				uris: new Set(),
				authors: new Set()
			};
			aggs.set(collection, a);
		}
		a.n += 1;
		if (rec.document) a.documents.add(String(rec.document));
		if (rec.dialect) a.dialects.add(String(rec.dialect));
		for (const d of (rec.dialect_lv1 as string[]) ?? []) a.dialectL1.add(d);
		if (rec.author) a.authors.add(String(rec.author));
		for (const ys of String(rec.recorded_at ?? '').match(/\d{4}/g) ?? []) {
			const yy = Number(ys);
			if (yy >= 1500 && yy <= 2100) a.recordedYears.push(yy);
		}
		for (const ys of String(rec.published_at ?? '').match(/\d{4}/g) ?? []) {
			const yy = Number(ys);
			if (yy >= 1500 && yy <= 2100) a.publishedYears.push(yy);
		}
		const uri = rec.uri as string | null;
		if (uri && /^https?:\/\//.test(uri) && a.uris.size < 5) a.uris.add(uri);
	}

	let count = 0;
	for (const a of aggs.values()) {
		const id = uuid();
		const meta = CORPUS_META[a.collection];
		const slug = uniqueSlug(meta?.slug ?? `corpus-${djb2(a.collection)}`);
		const region = a.dialectL1.has('北海道')
			? a.dialectL1.has('樺太')
				? 'other'
				: 'hokkaido'
			: a.dialectL1.has('樺太')
				? 'sakhalin'
				: '';
		// Prefer recording dates for chronology; fall back to publication only when
		// nothing was recorded — never mix the two into one span.
		const years = (a.recordedYears.length ? a.recordedYears : a.publishedYears).sort(
			(x, y) => x - y
		);
		const yearStart = years.length ? years[0] : null;
		const yearEnd = years.length ? years[years.length - 1] : null;
		const dialectLabel = [...a.dialects].slice(0, 4).join('、');
		sourceRows.push({
			id,
			slug,
			title: a.collection,
			titleEn: meta?.titleEn ?? null,
			category: 'corpus',
			type: 'corpus-text',
			author: a.authors.size === 1 ? [...a.authors][0] : null,
			yearText: yearStart ? (yearEnd && yearEnd !== yearStart ? `${yearStart}–${yearEnd}` : `${yearStart}`) : '',
			yearStart,
			yearEnd: yearEnd !== yearStart ? yearEnd : null,
			yearCertainty: yearStart ? (yearEnd && yearEnd !== yearStart ? 'range' : 'exact') : 'unknown',
			dialect: dialectLabel || null,
			region: region || null,
			languages: ['ain', 'jpn'],
			scripts: ['latn', 'kana'],
			entryCount: a.n,
			entryCountLabel: 'sentences',
			summary: `アイヌ語・日本語対訳テキスト集。${a.n.toLocaleString('en-US')} 文 / ${a.documents.size.toLocaleString('en-US')} 資料。`,
			provenanceRepo: 'ainu-corpora',
			provenancePath: a.collection,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		// links + holding institution from URIs
		let sortOrder = 0;
		let instAttached: string | null = null;
		for (const uri of a.uris) {
			const host = uri.replace(/^https?:\/\//, '').split('/')[0];
			linkRows.push({
				id: uuid(),
				sourceId: id,
				type: linkTypeFor(host),
				label: host,
				url: uri,
				sortOrder: sortOrder++
			});
			const inst = INSTITUTIONS[host];
			if (inst && instAttached !== inst.slug) {
				sourceInstRows.push({ id: uuid(), sourceId: id, institutionId: getInstitution(inst), role: 'holding' });
				instAttached = inst.slug;
			}
		}
		addPlaces(id, [...a.dialects].join(' ') + ' ' + [...a.dialectL1].join(' '));
		// Corpus collections are Ainu-language (mostly oral-literature) text sets;
		// the credited contributors are speakers / narrators (話者).
		for (const au of a.authors) addPersons(id, au, 'speaker');
		attachTags(id, a.collection, meta?.titleEn);
		count += 1;
	}
	return count;
}

// ---------------------------------------------------------------------------
// 4) Manual sources — modern tools, resources & media (the aynu.org ecosystem)
//
// Hand-curated, all verifiable at the listed URLs. Kept here (not in a sibling
// repo) so they survive a re-seed. provenanceRepo = 'manual'.
//
// ⚠ BANNED: never add YouTube channel UCb6agoDa9ujg0412JpeWdbg (AI-generated
//   content, unsuitable for a scholarly index).
// ---------------------------------------------------------------------------
interface ManualSource {
	slug: string;
	title: string;
	titleEn: string;
	type: string;
	category?: string; // defaults to 'tool'
	author?: string;
	languages: string[];
	scripts?: string[];
	yearStart?: number;
	summary: string;
	links: { type: string; url: string; label?: string }[];
}

const MANUAL_SOURCES: ManualSource[] = [
	{
		slug: 'aynuwiki',
		title: 'Aynuwiki',
		titleEn: 'Aynuwiki',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語・アイヌ文化に関する協同編集のウィキ。',
		links: [{ type: 'website', url: 'https://wiki.aynu.org/', label: 'wiki.aynu.org' }]
	},
	{
		slug: 'ukosamaani-sait',
		title: 'Ukosamaani Sait',
		titleEn: 'Ukosamaani Sait',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語のツール・リソースを集めたポータルサイト。',
		links: [{ type: 'website', url: 'https://site.aynu.org/', label: 'site.aynu.org' }]
	},
	{
		slug: 'poro-cinumkekampi',
		title: 'Poro Cinumkekampi',
		titleEn: 'Poro Cinumkekampi (online dictionary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'オンラインのアイヌ語辞典。',
		links: [{ type: 'website', url: 'https://dict.aynu.org/', label: 'dict.aynu.org' }]
	},
	{
		slug: 'itak-uoeroskip',
		title: 'Itak-uoeroskip',
		titleEn: 'Itak-uoeroskip (terminology glossary)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の用語集（言語学・文法用語などの対訳）。',
		links: [{ type: 'website', url: 'https://itak.aynu.org/', label: 'itak.aynu.org' }]
	},
	{
		slug: 'aynu-itah',
		title: 'Айну-Итах',
		titleEn: 'Ajnu-Itah (Russian–Ainu resource)',
		type: 'online-dictionary',
		author: 'aynumosir',
		languages: ['ain', 'rus'],
		scripts: ['latn', 'cyrl'],
		summary: 'ロシア語によるアイヌ語の辞書・資料。',
		links: [{ type: 'website', url: 'https://itah.aynu.org/', label: 'itah.aynu.org' }]
	},
	{
		slug: 'tu-itak-re-itak',
		title: 'tu itak re itak',
		titleEn: 'tu itak re itak (quiz)',
		type: 'website',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の学習クイズ。',
		links: [{ type: 'website', url: 'https://quiz.aynu.org/', label: 'quiz.aynu.org' }]
	},
	{
		slug: 'ainu-mcp',
		title: 'ainu-mcp',
		titleEn: 'ainu-mcp (Model Context Protocol server)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn', 'eng'],
		summary: 'アイヌ語の辞書・コーパス・文法を統合する Model Context Protocol サーバー。',
		links: [{ type: 'website', url: 'https://mcp.aynu.org/', label: 'mcp.aynu.org' }]
	},
	{
		slug: 'kampisos',
		title: 'Kampisos',
		titleEn: 'Kampisos (corpus search)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: '検索・絞り込み機能付きのアイヌ語コーパス（170万語以上）。',
		links: [{ type: 'website', url: 'https://kampisos.aynu.io/', label: 'kampisos.aynu.io' }]
	},
	{
		slug: 'tunci',
		title: 'Tunci',
		titleEn: 'Tunci (machine translation)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain', 'jpn'],
		summary: 'アイヌ語の機械翻訳ツール。',
		links: [{ type: 'website', url: 'https://tunci.aynu.io/', label: 'tunci.aynu.io' }]
	},
	{
		slug: 'minecraft-ainu',
		title: 'minecraft-ainu',
		titleEn: 'minecraft-ainu (resource pack)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'Minecraft をアイヌ語化するリソースパック。',
		links: [
			{ type: 'github', url: 'https://github.com/aynumosir/minecraft-ainu', label: 'GitHub' }
		]
	},
	{
		slug: 'ainconv',
		title: 'ainconv',
		titleEn: 'ainconv (script conversion library)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		scripts: ['latn', 'kana', 'cyrl'],
		summary: 'アイヌ語表記（ラテン文字・カナ・キリル文字）を相互変換するライブラリ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	},
	{
		slug: 'ainu-utils',
		title: 'ainu-utils',
		titleEn: 'ainu-utils (processing utilities)',
		type: 'software',
		author: 'aynumosir',
		languages: ['ain'],
		summary: 'アイヌ語テキスト処理ユーティリティ。npm / crates.io / PyPI で公開。',
		links: [{ type: 'github', url: 'https://github.com/aynumosir', label: 'GitHub (aynumosir)' }]
	}
];

// Video / animation sources (type: 'video', category: 'corpus').
// NOTE: サクアニメ entries go here once the exact channel/playlist URL is
// confirmed. The banned channel (see top of section) must never be listed.
const MANUAL_VIDEOS: ManualSource[] = [];

function seedManual(): number {
	const all = [...MANUAL_SOURCES, ...MANUAL_VIDEOS];
	for (const m of all) {
		const id = uuid();
		const slug = uniqueSlug(m.slug);
		sourceRows.push({
			id,
			slug,
			title: m.title,
			titleEn: m.titleEn,
			category: m.category ?? 'tool',
			type: m.type,
			author: m.author ?? null,
			yearText: m.yearStart ? `${m.yearStart}` : '',
			yearStart: m.yearStart ?? null,
			yearEnd: null,
			yearCertainty: m.yearStart ? 'exact' : 'unknown',
			languages: m.languages,
			scripts: m.scripts ?? ['latn'],
			summary: m.summary,
			provenanceRepo: 'manual',
			provenancePath: m.slug,
			createdAt: new Date(),
			updatedAt: new Date()
		});
		let sortOrder = 0;
		for (const l of m.links) {
			linkRows.push({
				id: uuid(),
				sourceId: id,
				type: l.type,
				label: l.label ?? null,
				url: l.url,
				sortOrder: sortOrder++
			});
		}
		attachTags(id, m.title, m.titleEn, m.type);
	}
	return all.length;
}

// ---------------------------------------------------------------------------
// 5) Academic index — Ainu *linguistics* literature collected from open
// repositories (OpenAlex, …) by scripts/collect-academic.ts. Ingested as
// `secondary` sources, deduped by DOI and normalized title against everything
// already loaded (esp. the ainu-grammar bibliography).
// ---------------------------------------------------------------------------
const ACADEMIC_FILE = path.join(import.meta.dir, 'data', 'academic-index.json');

const META_LANG: Record<string, string> = {
	en: 'eng', ja: 'jpn', ru: 'rus', de: 'deu', fr: 'fra', es: 'spa',
	it: 'ita', pl: 'pol', ko: 'kor', zh: 'zho', nl: 'nld', la: 'lat'
};

function normTitle(s: string): string {
	return (s || '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9぀-ヿ一-龯Ѐ-ӿ]+/g, '')
		.trim();
}

function seedAcademic(): { added: number; skipped: number } {
	if (!fs.existsSync(ACADEMIC_FILE)) {
		console.warn(`! academic index not found at ${ACADEMIC_FILE} — run collect-academic.ts; skipping`);
		return { added: 0, skipped: 0 };
	}
	interface Rec {
		source: string; externalId: string; doi: string | null; title: string;
		year: number | null; type: string; language: string | null;
		authors: string[]; venue: string | null; url: string | null; pdf: string | null;
	}
	const records: Rec[] = JSON.parse(fs.readFileSync(ACADEMIC_FILE, 'utf8'));

	// Dedup keys from everything already loaded.
	const seenTitles = new Set<string>();
	const seenDois = new Set<string>();
	for (const r of sourceRows) {
		seenTitles.add(normTitle(r.title as string));
		if (r.titleEn) seenTitles.add(normTitle(r.titleEn as string));
		const ext = r.externalIds as Record<string, string> | undefined;
		if (ext?.doi) seenDois.add(ext.doi.toLowerCase());
	}

	let added = 0;
	let skipped = 0;
	for (const rec of records) {
		const nt = normTitle(rec.title);
		const doi = rec.doi?.toLowerCase() ?? null;
		if (!nt || seenTitles.has(nt) || (doi && seenDois.has(doi))) {
			skipped += 1;
			continue;
		}
		seenTitles.add(nt);
		if (doi) seenDois.add(doi);

		const id = uuid();
		const y = parseYear(rec.year != null ? String(rec.year) : '');
		const metalang = rec.language && META_LANG[rec.language] ? META_LANG[rec.language] : null;
		const slug = uniqueSlug(
			`${rec.year ?? 'nd'}-${slugify(rec.authors[0] ?? '') || 'x'}-${slugify(rec.title).slice(0, 50) || djb2(rec.externalId)}`
		);
		sourceRows.push({
			id,
			slug,
			title: rec.title,
			titleEn: hasCJK(rec.title) ? null : rec.title,
			category: 'secondary',
			type: rec.type,
			author: rec.authors.join(', ') || null,
			...y,
			languages: metalang ? ['ain', metalang] : ['ain'],
			scripts: ['latn'],
			summary: rec.venue ?? null,
			provenanceRepo: rec.source,
			provenancePath: rec.externalId,
			externalIds: { ...(doi ? { doi } : {}), [rec.source]: rec.externalId },
			createdAt: new Date(),
			updatedAt: new Date()
		});
		let so = 0;
		if (rec.url) linkRows.push({ id: uuid(), sourceId: id, type: doi ? 'doi' : 'website', label: doi ? `doi:${rec.doi}` : rec.venue, url: rec.url, sortOrder: so++ });
		if (rec.pdf) linkRows.push({ id: uuid(), sourceId: id, type: 'pdf', label: 'Open access PDF', url: rec.pdf, sortOrder: so++ });
		attachTags(id, rec.title, 'grammar');
		added += 1;
	}
	return { added, skipped };
}

// ---------------------------------------------------------------------------
// Wikidata / Wikipedia enrichment for persons
//
// For each person we query the Wikidata API by name, accept ONLY a human (P31
// = Q5) whose label/alias matches the name, and keep its QID + an actually
// existing Wikipedia article URL. Results are cached to disk so re-seeds don't
// re-hit the API. Anything uncertain is left null → no link is shown (we never
// fabricate a link or guess an article that may not exist).
// ---------------------------------------------------------------------------
const WIKIDATA_CACHE_FILE = path.join(import.meta.dir, 'wikidata-cache.json');
const WD_UA = 'ainu-sources-seed/1.0 (https://db.aynu.org; mkpoli@mkpo.li)';

type WdHit = { wikidata: string | null; wikipedia: string | null; enLabel: string | null };

const ORG_RE =
	/consortium|project|contributors|wiktionary|et al|various|compiler|\bNINJAL\b|kyokai|kyōkai|foundation|museum|university|institute|\bAA研\b|loanwordbank|associat/i;

// The matched Wikidata entity's description must point to this domain, or we
// reject it — guards against same-name collisions (athletes, pop singers, …)
// that name-matching alone lets through.
const RELEVANCE_RE =
	/ainu|アイヌ|linguist|言語学|philolog|anthropolog|人類学|民族学|ethnolog|ethnograph|missionary|宣教|explorer|navigator|探検|naturalist|博物|orientalist|東洋学|japanolog|lexicograph|辞書|folklor|民俗|言語|方言|поэт|лингвист|этнограф|мореплавател|путешественник|священник|миссионер/i;

function normName(s: string): string {
	return stripParens(s)
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N} ]/gu, '')
		.replace(/\s+/g, '') // strip all spaces so "奥田 統己" matches label "奥田統己"
		.trim();
}

const wdSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch JSON from the Wikidata API. Retries on rate-limit (429) / 5xx with
 * backoff. Returns parsed JSON on success, null on a genuine non-retryable 4xx,
 * and THROWS after exhausting retries (so callers can avoid caching a transient
 * failure as a permanent "no match").
 */
async function wdFetch(url: string): Promise<any | null> {
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const res = await fetch(url, { headers: { 'User-Agent': WD_UA, Accept: 'application/json' } });
			if (res.status === 429 || res.status >= 500) {
				await wdSleep(500 * (attempt + 1));
				continue;
			}
			if (!res.ok) return null;
			return await res.json();
		} catch {
			await wdSleep(500 * (attempt + 1));
		}
	}
	throw new Error(`wdFetch failed after retries: ${url}`);
}

async function lookupWikidata(name: string, native: string): Promise<WdHit | null> {
	const empty: WdHit = { wikidata: null, wikipedia: null, enLabel: null };
	// Try the display name, the native name, and a space-stripped native variant
	// (Japanese names match better without the surname/given space on Wikidata).
	const queries = [name, native, native.replace(/\s+/g, '')].filter(
		(q, i, a) => q && a.indexOf(q) === i
	);
	const candidateIds: string[] = [];
	try {
		for (const q of queries) {
			const searchLang = hasCJK(q) ? 'ja' : 'en';
			const data = await wdFetch(
				`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=5&language=${searchLang}&uselang=${searchLang}&search=${encodeURIComponent(q)}`
			);
			for (const c of data?.search ?? []) if (!candidateIds.includes(c.id)) candidateIds.push(c.id);
			if (candidateIds.length >= 7) break;
		}
		if (!candidateIds.length) return empty;

		var ent = await wdFetch(
			`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims|sitelinks/urls|labels|aliases|descriptions&ids=${candidateIds.slice(0, 7).join('|')}`
		);
	} catch {
		return null; // transient API failure — let the caller retry next run
	}
	if (!ent?.entities) return empty;

	const wantCjk = hasCJK(native);
	// A full kanji name is highly unambiguous, so a *unique* such match is safe to
	// accept even when Wikidata has no description (many Ainu speakers/tradition-
	// bearers lack one). Common Latin/katakana names still require the relevance
	// gate, which keeps out same-name athletes/singers/actors.
	const kanjiName = /[㐀-鿿々]/.test(native) && native.replace(/\s+/g, '').length >= 3;
	const targets = [normName(name), normName(native)].filter(Boolean);

	// Collect human candidates whose label/alias actually matches the name.
	const matches: { e: any; id: string; relevant: boolean }[] = [];
	for (const id of candidateIds) {
		const e = ent.entities[id];
		if (!e || e.missing !== undefined) continue;
		const isHuman = (e.claims?.P31 ?? []).some(
			(c: any) => c?.mainsnak?.datavalue?.value?.id === 'Q5'
		);
		if (!isHuman) continue;
		const forms = new Set<string>();
		for (const lbl of Object.values(e.labels ?? {})) forms.add(normName((lbl as any).value));
		for (const arr of Object.values(e.aliases ?? {}))
			for (const a of arr as any[]) forms.add(normName(a.value));
		if (!targets.some((t) => t && forms.has(t))) continue;
		const descText = Object.values(e.descriptions ?? {})
			.map((d: any) => d.value)
			.join(' • ');
		matches.push({ e, id, relevant: RELEVANCE_RE.test(descText) });
	}
	if (!matches.length) return empty;

	// Prefer a relevance-confirmed match; otherwise accept a unique kanji-name hit.
	const chosen =
		matches.find((m) => m.relevant) ?? (kanjiName && matches.length === 1 ? matches[0] : null);
	if (!chosen) return empty;

	const sl = chosen.e.sitelinks ?? {};
	const order = wantCjk ? ['jawiki', 'enwiki', 'ruwiki'] : ['enwiki', 'jawiki', 'ruwiki'];
	let wikipedia: string | null = null;
	for (const wiki of order) {
		if (sl[wiki]?.url) {
			wikipedia = sl[wiki].url;
			break;
		}
	}
	const enLabel = chosen.e.labels?.en?.value ?? null;
	return { wikidata: chosen.id, wikipedia, enLabel: enLabel && !hasCJK(enLabel) ? enLabel : null };
}

async function enrichPersonsWithWikidata() {
	let cache: Record<string, WdHit> = {};
	if (fs.existsSync(WIKIDATA_CACHE_FILE)) {
		try {
			cache = JSON.parse(fs.readFileSync(WIKIDATA_CACHE_FILE, 'utf8'));
		} catch {
			cache = {};
		}
	}
	// Space/parenthesis-insensitive key so name normalization (e.g. adding the
	// surname/given space) doesn't invalidate cached lookups.
	const ck = (p: Row) => stripParens(p.name as string).replace(/\s+/g, '');
	const todo = personRows.filter((p) => !(ck(p) in cache));
	if (todo.length) {
		console.log(`Enriching ${todo.length} persons via Wikidata (cached: ${personRows.length - todo.length})…`);
	}
	const CONC = 3; // keep low to avoid Wikidata rate-limiting
	for (let i = 0; i < todo.length; i += CONC) {
		if (i > 0) await wdSleep(150);
		const batch = todo.slice(i, i + CONC);
		await Promise.all(
			batch.map(async (p) => {
				const display = (p.nameEn as string) || (p.name as string);
				if (ORG_RE.test(display)) {
					cache[ck(p)] = { wikidata: null, wikipedia: null, enLabel: null };
					return;
				}
				const hit = await lookupWikidata(display, p.name as string);
				if (hit) cache[ck(p)] = hit; // skip caching transient failures (null)
			})
		);
	}
	fs.writeFileSync(WIKIDATA_CACHE_FILE, JSON.stringify(cache, null, 2));
	let withWp = 0;
	let romajiFilled = 0;
	for (const p of personRows) {
		const hit = cache[ck(p)];
		if (!hit) continue;
		// Don't override hand-verified curated values (PERSON_ENRICH / PERSON_CANON).
		if (!p.wikidata) p.wikidata = hit.wikidata;
		if (!p.wikipedia) p.wikipedia = hit.wikipedia;
		if (hit.wikipedia) withWp += 1;
		// Backfill romaji for CJK-named people from the verified Wikidata label.
		if ((!p.nameEn || p.nameEn === p.name) && hit.enLabel && hasCJK(p.name as string)) {
			p.nameEn = hit.enLabel;
			romajiFilled += 1;
		}
	}
	console.log(
		`Wikidata: ${withWp} verified Wikipedia articles, ${romajiFilled} romaji names backfilled.`
	);
}

// ---------------------------------------------------------------------------
// Bulk insert helper (chunked)
// ---------------------------------------------------------------------------
async function bulkInsert(table: Parameters<typeof db.insert>[0], rows: Row[]) {
	const CHUNK = 200;
	for (let i = 0; i < rows.length; i += CHUNK) {
		await db.insert(table).values(rows.slice(i, i + CHUNK) as never);
	}
}

async function wipe() {
	// order matters: children before parents (FK)
	await db.delete(schema.sourceRevisions);
	await db.delete(schema.sourceRelations);
	await db.delete(schema.sourceTags);
	await db.delete(schema.sourcePersons);
	await db.delete(schema.sourcePlaces);
	await db.delete(schema.sourceInstitutions);
	await db.delete(schema.sourceLinks);
	await db.delete(schema.sources);
	await db.delete(schema.tags);
	await db.delete(schema.persons);
	await db.delete(schema.places);
	await db.delete(schema.institutions);
}

async function main() {
	console.log('AINU_ROOT =', AINU_ROOT);
	console.log('Wiping domain tables…');
	await wipe();

	const nDict = seedDictionaries();
	const nGram = seedGrammar();
	const nCorp = await seedCorpus();
	const nManual = seedManual();
	const acad = seedAcademic();

	await enrichPersonsWithWikidata();

	console.log('Inserting…');
	await bulkInsert(schema.persons, personRows);
	await bulkInsert(schema.places, placeRows);
	await bulkInsert(schema.institutions, instRows);
	await bulkInsert(schema.tags, tagRows);
	await bulkInsert(schema.sources, sourceRows);
	await bulkInsert(schema.sourceLinks, linkRows);
	await bulkInsert(schema.sourcePersons, sourcePersonRows);
	await bulkInsert(schema.sourcePlaces, sourcePlaceRows);
	await bulkInsert(schema.sourceInstitutions, sourceInstRows);
	await bulkInsert(schema.sourceTags, sourceTagRows);

	console.log('--- seeded ---');
	console.table({
		dictionaries: nDict,
		grammar: nGram,
		corpus: nCorp,
		manual: nManual,
		academic: acad.added,
		'academic dup': acad.skipped,
		sources: sourceRows.length,
		persons: personRows.length,
		places: placeRows.length,
		institutions: instRows.length,
		tags: tagRows.length,
		links: linkRows.length
	});
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
