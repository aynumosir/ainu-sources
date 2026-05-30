/**
 * Controlled vocabularies + localized labels for data-driven enum values.
 *
 * UI chrome strings live in Paraglide messages (`$lib/paraglide/messages`),
 * but enum *values* stored in the DB (source types, regions, roles, …) are
 * labelled here so we can render them in the current UI locale.
 */
import { getLocale } from '$lib/paraglide/runtime';

export type Locale = 'en' | 'ja' | 'ru' | 'ain';
/**
 * A localized label. en/ja/ru are required; ain (Ainu) is optional and falls
 * back to en when absent, so enum labels need not all be translated at once.
 */
export type L = Record<'en' | 'ja' | 'ru', string> & Partial<Record<'ain', string>>;

/** Resolve a localized label, falling back to en, then the raw key. */
export function tl(map: Record<string, L>, key: string | null | undefined): string {
	if (!key) return '';
	const entry = map[key];
	if (!entry) return key;
	const locale = getLocale() as Locale;
	return entry[locale] ?? entry.en ?? key;
}

// --- broad category (大分類) ---
export const CATEGORY_LABELS: Record<string, L> = {
	primary: { en: 'Primary source', ja: '一次資料', ru: 'Первоисточник', ain: 'hoski kampi' },
	secondary: { en: 'Research literature', ja: '研究文献', ru: 'Исследования', ain: 'siruanpare kampi' },
	corpus: { en: 'Corpus text', ja: 'コーパス', ru: 'Корпус', ain: 'itaksay topa' },
	tool: { en: 'Tool / resource', ja: 'ツール・リソース', ru: 'Инструмент / ресурс', ain: 'aeywankep' }
};

// --- fine source type (資料種別) ---
export const TYPE_LABELS: Record<string, L> = {
	'old-document': { en: 'Old document', ja: '古文献', ru: 'Старый документ' },
	dictionary: { en: 'Dictionary', ja: '辞典', ru: 'Словарь' },
	'topical-dictionary': { en: 'Topical dictionary', ja: 'トピック別辞典', ru: 'Тематический словарь' },
	'japanese-ainu-dictionary': { en: 'Japanese–Ainu dictionary', ja: '和愛辞典', ru: 'Японско-айнский словарь' },
	'online-dictionary': { en: 'Online dictionary', ja: 'オンライン辞典', ru: 'Онлайн-словарь' },
	wordlist: { en: 'Wordlist', ja: '語彙集', ru: 'Список слов' },
	'comparative-wordlist': { en: 'Comparative wordlist', ja: '比較語彙集', ru: 'Сравнительный список' },
	glossary: { en: 'Glossary', ja: '用語集', ru: 'Глоссарий' },
	nouns: { en: 'Noun list', ja: '名詞集', ru: 'Список существительных' },
	verbs: { en: 'Verb list', ja: '動詞集', ru: 'Список глаголов' },
	reference: { en: 'Reference dataset', ja: '参照データ', ru: 'Справочные данные' },
	'valency-dataset': { en: 'Valency dataset', ja: '結合価データ', ru: 'Данные валентности' },
	workbook: { en: 'Workbook', ja: 'ワークブック', ru: 'Рабочая тетрадь' },
	'grammar-book': { en: 'Grammar / book', ja: '文法書・単行本', ru: 'Грамматика / книга' },
	'grammar-article': { en: 'Article', ja: '論文', ru: 'Статья' },
	'corpus-text': { en: 'Corpus / text collection', ja: 'コーパス・テキスト集', ru: 'Корпус / собрание текстов' },
	// --- modern tools & media ---
	video: { en: 'Video / animation', ja: '動画・アニメ', ru: 'Видео / анимация' },
	software: { en: 'Software / app', ja: 'ソフトウェア・アプリ', ru: 'Программа / приложение' },
	website: { en: 'Website / portal', ja: 'ウェブサイト・ポータル', ru: 'Сайт / портал' }
};

// --- macro-region (地域) ---
export const REGION_LABELS: Record<string, L> = {
	hokkaido: { en: 'Hokkaidō', ja: '北海道', ru: 'Хоккайдо', ain: 'Yaunmosir' },
	sakhalin: { en: 'Sakhalin', ja: '樺太', ru: 'Сахалин', ain: 'Repunmosir' },
	kuril: { en: 'Kuril Islands', ja: '千島', ru: 'Курилы' },
	proto: { en: 'Proto-Ainu', ja: '祖アイヌ語', ru: 'Праайнский' },
	other: { en: 'Other / multiple', ja: 'その他・複数', ru: 'Другое', ain: 'oya' }
};

// --- languages (言語) ---
export const LANGUAGE_LABELS: Record<string, L> = {
	ain: { en: 'Ainu', ja: 'アイヌ語', ru: 'Айнский', ain: 'Aynu itak' },
	jpn: { en: 'Japanese', ja: '日本語', ru: 'Японский', ain: 'Sisam itak' },
	rus: { en: 'Russian', ja: 'ロシア語', ru: 'Русский', ain: 'Nuca itak' },
	eng: { en: 'English', ja: '英語', ru: 'Английский' },
	lat: { en: 'Latin', ja: 'ラテン語', ru: 'Латинский' },
	zho: { en: 'Chinese', ja: '中国語', ru: 'Китайский' }
};

// --- scripts (文字体系) ---
export const SCRIPT_LABELS: Record<string, L> = {
	latn: { en: 'Latin', ja: 'ローマ字', ru: 'Латиница' },
	kana: { en: 'Kana', ja: '仮名', ru: 'Кана' },
	cyrl: { en: 'Cyrillic', ja: 'キリル文字', ru: 'Кириллица' },
	kanji: { en: 'Kanji', ja: '漢字', ru: 'Иероглифы' }
};

// --- external link types ---
export const LINK_TYPE_LABELS: Record<string, L> = {
	iiif: { en: 'IIIF manifest', ja: 'IIIFマニフェスト', ru: 'IIIF-манифест' },
	image: { en: 'Digital images', ja: 'デジタル画像', ru: 'Изображения' },
	opac: { en: 'Library OPAC', ja: '図書館OPAC', ru: 'Каталог библиотеки' },
	ndl: { en: 'NDL Digital', ja: '国会図書館デジタル', ru: 'NDL' },
	cinii: { en: 'CiNii', ja: 'CiNii', ru: 'CiNii' },
	doi: { en: 'DOI', ja: 'DOI', ru: 'DOI' },
	transcription: { en: 'Transcription', ja: '翻刻', ru: 'Транскрипция' },
	github: { en: 'GitHub', ja: 'GitHub', ru: 'GitHub' },
	wikidata: { en: 'Wikidata', ja: 'Wikidata', ru: 'Wikidata' },
	pdf: { en: 'PDF', ja: 'PDF', ru: 'PDF' },
	website: { en: 'Website', ja: 'ウェブサイト', ru: 'Сайт' },
	youtube: { en: 'YouTube', ja: 'YouTube', ru: 'YouTube' },
	npm: { en: 'npm', ja: 'npm', ru: 'npm' },
	huggingface: { en: 'Hugging Face', ja: 'Hugging Face', ru: 'Hugging Face' },
	api: { en: 'API', ja: 'API', ru: 'API' },
	other: { en: 'Link', ja: 'リンク', ru: 'Ссылка' }
};

// --- person roles ---
export const PERSON_ROLE_LABELS: Record<string, L> = {
	author: { en: 'Author', ja: '著者', ru: 'Автор', ain: 'inuyekur' },
	editor: { en: 'Editor', ja: '編者', ru: 'Редактор' },
	compiler: { en: 'Compiler', ja: '編纂者', ru: 'Составитель' },
	recorder: { en: 'Recorder', ja: '記録者', ru: 'Записал' },
	speaker: { en: 'Speaker', ja: '話者', ru: 'Носитель', ain: 'itak kor kur' },
	transcriber: { en: 'Transcriber', ja: '翻刻者', ru: 'Транскриптор' },
	translator: { en: 'Translator', ja: '翻訳者', ru: 'Переводчик' },
	researcher: { en: 'Researcher', ja: '研究者', ru: 'Исследователь', ain: 'siruanpare kur' }
};

// --- place roles ---
export const PLACE_ROLE_LABELS: Record<string, L> = {
	composition: { en: 'Place of composition', ja: '成立地', ru: 'Место создания' },
	record: { en: 'Place of record', ja: '記録地', ru: 'Место записи' },
	dialect: { en: 'Dialect area', ja: '方言地域', ru: 'Диалектная область' },
	subject: { en: 'Subject area', ja: '対象地域', ru: 'Объектная область' },
	holding: { en: 'Holding location', ja: '所蔵地', ru: 'Место хранения' }
};

// --- source-to-source relation types ---
export const RELATION_TYPE_LABELS: Record<string, L> = {
	cites: { en: 'Cites', ja: '引用', ru: 'Цитирует' },
	'manuscript-of': { en: 'Manuscript of', ja: '写本', ru: 'Рукопись' },
	'edition-of': { en: 'Edition of', ja: '刊本', ru: 'Издание' },
	'transcription-of': { en: 'Transcription of', ja: '翻刻', ru: 'Транскрипция' },
	'derived-from': { en: 'Derived from', ja: '派生', ru: 'Производно от' },
	related: { en: 'Related', ja: '関連', ru: 'Связано' },
	'same-work': { en: 'Same work', ja: '同一著作', ru: 'То же произведение' }
};

export const YEAR_CERTAINTY_LABELS: Record<string, L> = {
	exact: { en: 'exact', ja: '確実', ru: 'точно' },
	range: { en: 'range', ja: '範囲', ru: 'диапазон' },
	estimated: { en: 'estimated', ja: '推定', ru: 'оценка' },
	unknown: { en: 'unknown', ja: '不明', ru: 'неизвестно' }
};

export const TAG_CATEGORY_LABELS: Record<string, L> = {
	topic: { en: 'Topic', ja: '主題', ru: 'Тема' },
	genre: { en: 'Genre', ja: 'ジャンル', ru: 'Жанр' },
	feature: { en: 'Feature', ja: '特徴', ru: 'Особенность' },
	dialect: { en: 'Dialect', ja: '方言', ru: 'Диалект' }
};

/** Ordered keys for filter UIs. */
export const TYPE_ORDER = Object.keys(TYPE_LABELS);
export const CATEGORY_ORDER = ['primary', 'corpus', 'secondary', 'tool'];
export const REGION_ORDER = ['hokkaido', 'sakhalin', 'kuril', 'proto', 'other'];
export const LANGUAGE_ORDER = Object.keys(LANGUAGE_LABELS);
export const SCRIPT_ORDER = Object.keys(SCRIPT_LABELS);

/** Color accents per category (Tailwind classes). */
export const CATEGORY_ACCENT: Record<string, string> = {
	primary: 'bg-amber-100 text-amber-900 ring-amber-300',
	corpus: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
	secondary: 'bg-sky-100 text-sky-900 ring-sky-300',
	tool: 'bg-violet-100 text-violet-900 ring-violet-300'
};
