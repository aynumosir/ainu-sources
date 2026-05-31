/**
 * Collect an Ainu *linguistics* academic index from open repositories and write
 * a reviewable JSON dataset to scripts/data/academic-index.json.
 *
 * Run:  bun scripts/collect-academic.ts
 *
 * The seed (`seedAcademic` in seed.ts) ingests that JSON as `secondary` sources,
 * deduped against the existing ainu-grammar bibliography by DOI and title.
 *
 * Sources implemented here: OpenAlex (open, no key). Crossref / CiNii / Zenodo /
 * Glottolog are added as additional collectors over time. Everything is REAL,
 * fetched data with provenance — nothing is synthesized.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.join(import.meta.dir, 'data');
const OUT_FILE = path.join(OUT_DIR, 'academic-index.json');
const MAILTO = 'mkpoli@mkpo.li';
const UA = 'ainu-sources-collector/1.0 (https://db.aynu.org; mkpoli@mkpo.li)';
const LINGUISTICS = 'C41895202'; // OpenAlex concept: Linguistics

export interface AcademicRecord {
	source: string; // 'openalex' | 'crossref' | 'cinii' | 'togo' | 'hoppodb' | 'sgu' | ...
	externalId: string;
	doi: string | null;
	title: string;
	year: number | null;
	type: string; // normalized: 'grammar-book' | 'grammar-article'
	rawType: string;
	language: string | null;
	authors: string[];
	venue: string | null;
	url: string | null; // canonical landing (DOI or OA)
	pdf: string | null; // open-access PDF if any
	category?: string; // 'secondary' (default) | 'primary' (e.g. Edo-period wordlists)
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '');

async function htext(url: string): Promise<string> {
	const res = await fetch(url, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	return res.text();
}

async function jget(url: string): Promise<any> {
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	return res.json();
}

function normType(t: string): string {
	return /book|monograph|dissertation|thesis/i.test(t) ? 'grammar-book' : 'grammar-article';
}

// Map a raw OpenAlex work object → our AcademicRecord (shared by every OpenAlex
// collector: keyword, native-script, and citation-chained).
function oaRecord(w: any): AcademicRecord {
	const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null;
	const loc = w.primary_location ?? w.best_oa_location ?? null;
	const oa = w.best_oa_location ?? null;
	return {
		source: 'openalex',
		externalId: String(w.id).replace('https://openalex.org/', ''),
		doi,
		title: (w.title ?? w.display_name ?? '').trim(),
		year: w.publication_year ?? null,
		type: normType(w.type ?? ''),
		rawType: w.type ?? '',
		language: w.language ?? null,
		authors: (w.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
		venue: loc?.source?.display_name ?? null,
		url: w.doi ?? loc?.landing_page_url ?? String(w.id),
		pdf: oa?.pdf_url ?? null
	};
}

// --- OpenAlex --------------------------------------------------------------
async function collectOpenAlex(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	let cursor = '*';
	let page = 0;
	while (cursor) {
		const url =
			`https://api.openalex.org/works?filter=title.search:Ainu,concepts.id:${LINGUISTICS}` +
			`&per-page=200&cursor=${encodeURIComponent(cursor)}&mailto=${MAILTO}`;
		const data = await jget(url);
		for (const w of data.results ?? []) out.push(oaRecord(w));
		cursor = data.meta?.next_cursor ?? null;
		page += 1;
		console.log(`  OpenAlex page ${page}: +${data.results?.length ?? 0} (total ${out.length})`);
		if (!data.results?.length) break;
	}
	return out;
}

// --- OpenAlex native-script titles (CJK Ainu linguistics) -------------------
// The Latin "Ainu" collectors above never see CJK-titled works — their titles
// say 阿伊努 / 愛努 / 아이누, never "Ainu". We search the native transliterations,
// then keep ONLY language/linguistics works (project scope) and drop the
// scattered-character noise OpenAlex's CJK tokenizer returns for short queries.
// Both the bare ethnonym and the explicit "Ainu language" forms — CJK tokenizers
// (esp. Korean) index 아이누어 / 愛努語 as tokens distinct from the bare 아이누 / 愛努,
// so the language-suffixed terms must be searched in their own right.
const AINU_NATIVE = [
	'阿伊努', '阿依努', '爱努', '愛努', '阿伊奴', '아이누',
	'阿伊努語', '阿伊努语', '爱努语', '愛努語', '아이누어'
];
// A genuine Ainu mention = one of these as a CONTIGUOUS substring of the title
// (filters out hits where 阿/伊/努 merely scatter across an unrelated name).
const AINU_SUBSTR_RE = /阿伊努|阿依努|爱努|愛努|阿伊奴|아이누/;
// "Ainu language" stated outright (Ainu term + language suffix) — strongest cue.
const AINU_LANG_RE = /(?:阿伊努|阿依努|爱努|愛努|阿伊奴)[語语]|아이누어/;
// Otherwise the title must carry a linguistics marker to qualify as in-scope.
const CJK_LING_RE =
	/[語语]|言語|语言|方言|文法|音韻|音韵|音声|文字|語彙|词汇|詞彙|語源|動詞|动词|名詞|名词|詞綴|词缀|언어|방언|문법|음운|동사|명사|음성|어휘/;

function isAinuLinguistics(title: string): boolean {
	if (!AINU_SUBSTR_RE.test(title)) return false;
	return AINU_LANG_RE.test(title) || CJK_LING_RE.test(title);
}

async function collectOpenAlexNative(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const term of AINU_NATIVE) {
		const url =
			`https://api.openalex.org/works?filter=title.search:${encodeURIComponent(term)}` +
			`&per-page=200&mailto=${MAILTO}`;
		let data: any;
		try {
			data = await jget(url);
		} catch {
			continue;
		}
		let kept = 0;
		for (const w of data.results ?? []) {
			const title = (w.title ?? w.display_name ?? '').trim();
			if (!isAinuLinguistics(title)) continue;
			const id = String(w.id).replace('https://openalex.org/', '');
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(oaRecord(w));
			kept += 1;
		}
		console.log(`  OpenAlex native "${term}": +${kept} (total ${out.length})`);
	}
	return out;
}

// --- OpenAlex citation chaining (snowball through bibliographies) -----------
// Take the Ainu-linguistics works we already found on OpenAlex, walk their
// `referenced_works` (the bibliographies), and keep cited works that are
// themselves in scope — recovering papers our keyword/title searches missed.
// Snowballs: each newly found Ainu work seeds the next hop until nothing new
// surfaces (or MAX_HOPS). Every discovered work is re-checked against the SAME
// linguistics bar as collectOpenAlex (Ainu in title + a Linguistics concept/
// topic; CJK titles via isAinuLinguistics), so chaining widens recall without
// drifting into Ainu genetics/anthropology/history.
const CHAIN_MAX_HOPS = 4;
const CHAIN_CHUNK = 50; // OpenAlex OR-filter accepts up to 50 ids per request
const CHAIN_MAX_FETCH = 12000; // safety cap on referenced works pulled (logged if hit)

function isLinguistics(w: any): boolean {
	if ((w.concepts ?? []).some((c: any) => String(c.id ?? '').endsWith(LINGUISTICS))) return true;
	const fields = [
		w.primary_topic?.field?.display_name,
		w.primary_topic?.subfield?.display_name,
		...(w.topics ?? []).map((t: any) => t.field?.display_name)
	];
	return fields.some((f: string | undefined) => /linguist/i.test(f ?? ''));
}

function chainInScope(w: any): boolean {
	const title = (w.title ?? w.display_name ?? '').trim();
	if (!title) return false;
	if (/ainu/i.test(title)) return isLinguistics(w); // Latin "Ainu" → require linguistics
	return isAinuLinguistics(title); // CJK native term (already linguistics-gated)
}

const chunk = <T>(arr: T[], n: number): T[][] => {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
	return out;
};

// Fetch full work objects for a batch of OpenAlex IDs (≤50) via the OR filter.
async function fetchWorksByIds(ids: string[]): Promise<any[]> {
	if (!ids.length) return [];
	const url =
		`https://api.openalex.org/works?filter=ids.openalex:${ids.join('|')}` +
		`&per-page=${ids.length}&mailto=${MAILTO}`;
	try {
		return (await jget(url)).results ?? [];
	} catch {
		return [];
	}
}

async function collectOpenAlexChained(seedIds: string[]): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const knownWorks = new Set(seedIds); // works already in our index (don't re-emit)
	const probedRefs = new Set<string>(); // referenced works already fetched (don't refetch)
	let frontier = [...seedIds];
	let fetched = 0;

	for (let hop = 1; hop <= CHAIN_MAX_HOPS && frontier.length; hop++) {
		// 1) Gather the bibliographies of the current frontier.
		const refIds = new Set<string>();
		for (const batch of chunk(frontier, CHAIN_CHUNK)) {
			const url =
				`https://api.openalex.org/works?filter=ids.openalex:${batch.join('|')}` +
				`&per-page=${batch.length}&select=id,referenced_works&mailto=${MAILTO}`;
			let data: any;
			try {
				data = await jget(url);
			} catch {
				continue;
			}
			for (const w of data.results ?? [])
				for (const r of w.referenced_works ?? []) {
					const id = String(r).replace('https://openalex.org/', '');
					if (!knownWorks.has(id) && !probedRefs.has(id)) refIds.add(id);
				}
		}
		if (!refIds.size) break;

		// 2) Fetch those cited works and keep the in-scope ones.
		const toFetch = [...refIds].slice(0, Math.max(0, CHAIN_MAX_FETCH - fetched));
		if (toFetch.length < refIds.size)
			console.log(`  ! chain: CHAIN_MAX_FETCH reached, skipping ${refIds.size - toFetch.length} refs`);
		const nextFrontier: string[] = [];
		for (const batch of chunk(toFetch, CHAIN_CHUNK)) {
			const works = await fetchWorksByIds(batch);
			fetched += batch.length;
			for (const w of works) {
				const id = String(w.id).replace('https://openalex.org/', '');
				probedRefs.add(id);
				if (knownWorks.has(id) || !chainInScope(w)) continue;
				knownWorks.add(id);
				out.push(oaRecord(w));
				nextFrontier.push(id); // chain onward from newly found Ainu works
			}
		}
		console.log(`  OpenAlex chain hop ${hop}: probed ${toFetch.length} refs, +${nextFrontier.length} in scope (total ${out.length})`);
		frontier = nextFrontier;
	}
	return out;
}

// --- OpenAlex forward citation chaining (works that CITE our articles) ------
// The mirror of collectOpenAlexChained: instead of a work's bibliography we
// follow its citers. `filter=cites:W1|W2,title.search:Ainu` returns Ainu-titled
// works citing any seed — cheap and precise. (Prefilter is Latin "Ainu"; CJK/
// Cyrillic forward-citers are negligible and already covered by the keyword,
// native-script, and backward-chain passes.) chainInScope still enforces the
// Linguistics bar; each new citer seeds the next hop until nothing new surfaces.
async function collectOpenAlexForwardChained(seedIds: string[]): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const knownWorks = new Set(seedIds);
	let frontier = [...seedIds];

	for (let hop = 1; hop <= CHAIN_MAX_HOPS && frontier.length; hop++) {
		const nextFrontier: string[] = [];
		for (const batch of chunk(frontier, CHAIN_CHUNK)) {
			let cursor: string | null = '*';
			let pages = 0;
			while (cursor && pages < 10) {
				const url =
					`https://api.openalex.org/works?filter=cites:${batch.join('|')},title.search:Ainu` +
					`&per-page=200&cursor=${encodeURIComponent(cursor)}&mailto=${MAILTO}`;
				let data: any;
				try {
					data = await jget(url);
				} catch {
					break;
				}
				for (const w of data.results ?? []) {
					const id = String(w.id).replace('https://openalex.org/', '');
					if (knownWorks.has(id) || !chainInScope(w)) continue;
					knownWorks.add(id);
					out.push(oaRecord(w));
					nextFrontier.push(id);
				}
				cursor = data.meta?.next_cursor ?? null;
				pages += 1;
				if (!data.results?.length) break;
			}
		}
		console.log(`  OpenAlex forward-chain hop ${hop}: +${nextFrontier.length} in scope (total ${out.length})`);
		frontier = nextFrontier;
	}
	return out;
}

// --- Crossref ---------------------------------------------------------------
async function collectCrossref(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const ROWS = 100; // Crossref rejects larger page sizes here
	for (let offset = 0; offset < 1000; offset += ROWS) {
		const url =
			`https://api.crossref.org/works?query=${encodeURIComponent('Ainu language')}` +
			`&rows=${ROWS}&offset=${offset}&select=DOI,title,author,issued,type,container-title&mailto=${MAILTO}`;
		let data: any;
		try {
			data = await jget(url);
		} catch {
			break;
		}
		const items = data.message?.items ?? [];
		for (const w of items) {
			const title = (w.title?.[0] ?? '').trim();
			if (!/ainu/i.test(title)) continue; // title precision filter
			out.push({
				source: 'crossref',
				externalId: w.DOI,
				doi: w.DOI ?? null,
				title,
				year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
				type: normType(w.type ?? ''),
				rawType: w.type ?? '',
				language: null,
				authors: (w.author ?? [])
					.map((a: any) => [a.given, a.family].filter(Boolean).join(' ').trim())
					.filter(Boolean),
				venue: w['container-title']?.[0] ?? null,
				url: w.DOI ? `https://doi.org/${w.DOI}` : null,
				pdf: null
			});
		}
		console.log(`  Crossref offset ${offset}: kept ${out.length} (Ainu-titled)`);
		if (items.length < ROWS) break;
	}
	return out;
}

// --- CiNii Research ---------------------------------------------------------
// Several Hokkaido-focused Ainu-linguistics queries, incl. the Hokkaido Ainu
// Culture Research Center bulletin, dialect & grammar studies. Deduped by id.
const CINII_QUERIES = [
	'アイヌ語',
	'アイヌ語 方言',
	'アイヌ語 文法',
	'アイヌ語 音韻',
	'アイヌ民族文化研究センター研究紀要'
];

async function collectCiNii(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const COUNT = 200;
	for (const q of CINII_QUERIES) {
		for (let start = 1; start <= 600; start += COUNT) {
			const url =
				`https://cir.nii.ac.jp/opensearch/all?q=${encodeURIComponent(q)}` +
				`&format=json&count=${COUNT}&start=${start}`;
			let data: any;
			try {
				data = await jget(url);
			} catch {
				break;
			}
			const items = data.items ?? [];
			for (const w of items) {
				const title = String(w.title ?? w['dc:title'] ?? '').trim();
				if (!title || !/アイヌ|ainu/i.test(title)) continue;
				const id = String(w['@id'] ?? w.link?.['@id'] ?? title);
				if (seen.has(id)) continue;
				seen.add(id);
				const rawCreators = w['dc:creator'] ?? w.creator ?? [];
				const creators = (Array.isArray(rawCreators) ? rawCreators : [rawCreators])
					.map((c: any) => (typeof c === 'string' ? c : c?.['@value'] ?? c?.['foaf:name'] ?? ''))
					.filter(Boolean);
				const dateStr = String(w['prism:publicationDate'] ?? w['dc:date'] ?? w['dcterms:date'] ?? '');
				const year = Number((dateStr.match(/\d{4}/) ?? [])[0]) || null;
				const link = w.link?.['@id'] ?? w['@id'] ?? null;
				out.push({
					source: 'cinii',
					externalId: id,
					doi: null,
					title,
					year,
					type: 'grammar-article',
					rawType: String(w['dc:type'] ?? ''),
					language: /[぀-ヿ㐀-鿿一-鿿]/.test(title) ? 'ja' : 'en',
					authors: creators,
					venue: w['prism:publicationName'] ?? null,
					url: link,
					pdf: null
				});
			}
			if (items.length < COUNT) break;
		}
		console.log(`  CiNii "${q}": cumulative ${out.length}`);
	}
	return out;
}

// --- Open Library (books, no key) ------------------------------------------
const OL_LANG: Record<string, string> = { eng: 'en', jpn: 'ja', rus: 'ru', ger: 'de', fre: 'fr', ita: 'it', pol: 'pl', dut: 'nl', lat: 'la' };
const OL_QUERIES = ['Ainu language', 'Ainu grammar', 'Ainu dictionary'];

async function collectOpenLibrary(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const q of OL_QUERIES) {
		for (let page = 1; page <= 3; page++) {
			const url =
				`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}` +
				`&fields=title,author_name,first_publish_year,key,language&limit=100&page=${page}`;
			let d: any;
			try {
				d = await jget(url);
			} catch {
				break;
			}
			const docs = d.docs ?? [];
			for (const w of docs) {
				const title = String(w.title ?? '').trim();
				if (!title || !/ainu/i.test(title)) continue;
				const key = w.key;
				if (!key || seen.has(key)) continue;
				seen.add(key);
				out.push({
					source: 'openlibrary',
					externalId: key,
					doi: null,
					title,
					year: w.first_publish_year ?? null,
					type: 'grammar-book',
					rawType: 'book',
					language: OL_LANG[w.language?.[0]] ?? null,
					authors: w.author_name ?? [],
					venue: null,
					url: `https://openlibrary.org${key}`,
					pdf: null
				});
			}
			if (docs.length < 100) break;
		}
		console.log(`  OpenLibrary "${q}": cumulative ${out.length}`);
	}
	return out;
}

// --- NDL Search (National Diet Library — Japanese book catalog) -------------
async function collectNDL(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const cdata = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
	for (let idx = 1; idx <= 800; idx += 200) {
		const url =
			`https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent('アイヌ語')}` +
			`&dpid=iss-ndl-opac&cnt=200&idx=${idx}`;
		let xml: string;
		try {
			xml = await (await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/xml' } })).text();
		} catch {
			break;
		}
		const items = xml.split('<item>').slice(1);
		if (!items.length) break;
		for (const it of items) {
			const title = cdata(it.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '');
			if (!title || !/アイヌ|ainu/i.test(title)) continue;
			const link = (it.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? '').trim();
			const id = link || title;
			if (seen.has(id)) continue;
			seen.add(id);
			const dateStr =
				it.match(/<dcterms:issued[^>]*>([\s\S]*?)<\/dcterms:issued>/)?.[1] ??
				it.match(/<dc:date>([\s\S]*?)<\/dc:date>/)?.[1] ??
				it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ??
				'';
			const year = Number((dateStr.match(/\d{4}/) ?? [])[0]) || null;
			const author = cdata(
				it.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/)?.[1] ??
					it.match(/<author>([\s\S]*?)<\/author>/)?.[1] ??
					''
			)
				.replace(/,?\s*\d{4}-(\d{4})?\.?$/, '') // drop trailing life-dates
				.trim();
			out.push({
				source: 'ndl',
				externalId: id,
				doi: null,
				title,
				year,
				type: 'grammar-book',
				rawType: 'book',
				language: 'ja',
				authors: author ? [author] : [],
				venue: null,
				url: link || null,
				pdf: null
			});
		}
		if (items.length < 200) break;
	}
	console.log(`  NDL books: ${out.length}`);
	return out;
}

// --- CyberLeninka (Russian open-access scholarship) ------------------------
const CL_QUERIES = ['айнский язык', 'айнского языка', 'сахалинские айны язык'];

async function collectCyberLeninka(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const q of CL_QUERIES) {
		for (let from = 0; from < 400; from += 100) {
			let data: any;
			try {
				const res = await fetch('https://cyberleninka.ru/api/search', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
					body: JSON.stringify({ mode: 'articles', q, size: 100, from })
				});
				data = await res.json();
			} catch {
				break;
			}
			const arts = data.articles ?? [];
			if (!arts.length) break;
			for (const a of arts) {
				const title = String(a.name ?? '').replace(/<\/?b>/g, '').trim();
				if (!title || !/айн/i.test(title)) continue;
				const id = a.link || title;
				if (seen.has(id)) continue;
				seen.add(id);
				out.push({
					source: 'cyberleninka',
					externalId: id,
					doi: null,
					title,
					year: Number(a.year) || null,
					type: 'grammar-article',
					rawType: 'article',
					language: 'ru',
					authors: Array.isArray(a.authors) ? a.authors : [],
					venue: a.journal ?? null,
					url: a.link ? `https://cyberleninka.ru${a.link}` : null,
					pdf: null
				});
			}
			if (arts.length < 100) break;
		}
		console.log(`  CyberLeninka "${q}": cumulative ${out.length}`);
	}
	return out;
}

function normTitle(s: string): string {
	return (s || '')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		// Keep Hangul too (NFKD → conjoining jamo U+1100–U+11FF); otherwise Korean
		// titles normalize to '' and slip past dedup. Mirrors seed.ts normTitle.
		.replace(/[^a-z0-9぀-ヿ一-龯Ѐ-ӿᄀ-ᇿ가-힣]+/g, '');
}

// --- Hosei TOGO (北方史統合検索データベース) -------------------------------------
// A Northern-history bibliography DB; we query the language/toponymy slice. Most
// records are 山田秀三-school Ainu place-name studies — pre-modern Japanese-only
// works invisible to OpenAlex/Crossref. Keep ONLY language/linguistics records
// (地名 toponymy = Ainu place-name etymology counts as linguistic); drop history.
const TOGO_BASE = 'https://aterui.ws.hosei.ac.jp/togo/';
const TOGO_QUERIES = ['アイヌ語地名', 'アイヌ語'];
const TOGO_LING_RE = /アイヌ語|地名|方言|文法|音[韻声]|語彙|単語|会話|言語|辞[書典]|発音|語源|文字/;

export async function collectTOGO(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const q of TOGO_QUERIES) {
		for (let page = 1; page <= 30; page++) {
			const url = `${TOGO_BASE}?query=${encodeURIComponent(q)}&page=${page}&size=100&ezo=&ando=&ainu=`;
			let html: string;
			try {
				html = await htext(url);
			} catch {
				break;
			}
			const items = html.split('<li class="list-group-item bg-transparent border-dark"').slice(1);
			if (!items.length) break;
			let kept = 0;
			for (const it of items) {
				const idm = it.match(/detail\.php\?id=(\d+)&domain=(\w+)/);
				if (!idm) continue;
				const extId = `${idm[2]}-${idm[1]}`;
				if (seen.has(extId)) continue;
				const titm = it.match(/text-reset">([\s\S]*?)<\/a>/);
				// Collapse ONLY ASCII whitespace — keep the full-width space (U+3000)
				// that joins 姓　名 so the title still splits on the half-width space.
				let head = titm ? stripTags(titm[1]).replace(/[\t\n\r ]+/g, ' ').trim() : '';
				head = head.replace(/^\d+\.\s*/, ''); // strip "NN. "
				// Author name uses a full-width space (姓　名); the article title is
				// separated from it by the first half-width space.
				const sp = head.indexOf(' ');
				const author = (sp >= 0 ? head.slice(0, sp) : head).replace(/　/g, ' ').trim();
				let title = sp >= 0 ? head.slice(sp + 1).trim() : '';
				const ym = it.match(/刊行年：(\d{4})/);
				const year = ym ? Number(ym[1]) : null;
				const vm = it.match(/データ：([\s\S]*?)<\/div>/);
				const venue = vm ? stripTags(vm[1]).replace(/\s+/g, ' ').trim() : null;
				if (!title) {
					const bk = venue?.match(/『([^』]+)』/); // title-less rows → containing 『book』
					title = bk ? bk[1] : venue ?? '';
				}
				if (!title || title.length < 2) continue;
				if (!TOGO_LING_RE.test(`${title} ${venue ?? ''}`)) continue; // linguistics-only
				seen.add(extId);
				out.push({
					source: 'togo',
					externalId: extId,
					doi: null,
					title,
					year,
					type: 'grammar-article',
					rawType: 'togo-record',
					language: 'ja',
					authors: author && !/(会|編)$/.test(author) ? [author] : [],
					venue,
					url: `${TOGO_BASE}detail.php?id=${idm[1]}&domain=${idm[2]}`,
					pdf: null
				});
				kept += 1;
			}
			console.log(`  TOGO "${q}" page ${page}: +${kept} (total ${out.length})`);
			if (items.length < 100) break;
		}
	}
	return out;
}

// --- Hokudai 北方資料データベース (hoppodb) ------------------------------------
// An archival catalogue (manuscripts/photos/maps/pamphlets). Keep ONLY items
// whose title signals Ainu-LANGUAGE content — Edo-period vocabularies, 通詞
// (interpreter) records, チャランケ oral texts — which are PRIMARY linguistic
// sources absent from every other index; everything else is off-scope history.
const HOPPO_IDX = ['0A', '0B', '0C', '0D', '0E', '0F', '0G', '0H', '0I'];
const HOPPO_QUERIES = ['アイヌ語', '蝦夷語', 'ことば', '語彙'];
const HOPPO_LANG_RE =
	/ことば|コトバ|言葉|ことは|ゑそ|ヱソ|語彙|単語|對話|対話|会話|方言|蝦夷語|アイヌ語|通詞|通弁|チャランケ|訳語|和解|辞[書典]/;

export async function collectHoppoDB(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const idx = HOPPO_IDX.map((c) => `idxname%5B%5D=${c}`).join('&');
	for (const q of HOPPO_QUERIES) {
		const url =
			`https://www.lib.hokudai.ac.jp/hoppodb/hoppo.php?FF=1&op=and&max=100` +
			`&word=${encodeURIComponent(q)}&${idx}`;
		let html: string;
		try {
			html = await htext(url);
		} catch {
			continue;
		}
		let kept = 0;
		for (const m of html.matchAll(/record\.cgi\?id=([0-9A-Za-z]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
			const id = m[1];
			if (seen.has(id)) continue;
			const full = stripTags(m[2])
				.replace(/&nbsp;/g, ' ')
				.replace(/[\t\n\r ]+/g, ' ')
				.trim();
			const [titlePart, ...authorParts] = full.split(/\s*\/\s*/); // "title / author"
			const title = titlePart.trim();
			if (!title || !HOPPO_LANG_RE.test(title)) continue; // language-only
			seen.add(id);
			const author = authorParts.join(' / ').replace(/[（(][^）)]*[)）]/g, '').trim();
			out.push({
				source: 'hoppodb',
				externalId: id,
				doi: null,
				title,
				year: null,
				type: 'grammar-book',
				rawType: 'hoppodb-record',
				language: 'ja',
				authors: author ? [author] : [],
				venue: null,
				url: `https://www.lib.hokudai.ac.jp/cgi-bin/hoppodb/record.cgi?id=${id}`,
				pdf: null,
				category: 'primary' // Edo-period sources, not research literature
			});
			kept += 1;
		}
		console.log(`  hoppodb "${q}": +${kept} (total ${out.length})`);
	}
	return out;
}

// --- Sapporo Gakuin University curated Ainu bibliography --------------------
// A hand-curated essential reading list for Ainu-LANGUAGE learners (ISO-2022-JP
// encoded). High overlap with NDL/CiNii — dedup keeps only what's new — but it
// surfaces a few canonical works and is authoritative for the language canon.
const SGU_URL = 'https://pub.sgu.ac.jp/~ainu/biblio/japanese.html';
// Language/oral-literature only — NOT bare アイヌ/文化 (drops ethnography & culture).
const SGU_LING_RE =
	/アイヌ語|語彙|方言|文法|会話|単語|地名|辞[書典]|音[韻声]|テキスト|教材|学習書|文典|ユーカラ|ユカ|神謡|口承|口承文芸|物語|語り|フィールドワーク|言語|アイヌ語の/;

export async function collectSGU(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	let text: string;
	try {
		const ab = await (await fetch(SGU_URL, { headers: { 'User-Agent': UA } })).arrayBuffer();
		text = new TextDecoder('iso-2022-jp').decode(ab);
	} catch {
		return out;
	}
	const plain = stripTags(text).replace(/&nbsp;/g, ' ');
	const seen = new Set<string>();
	// authors(year)『title』 — years are HALF-width here; titles follow immediately.
	// Exclude 『 from the author capture so it can't swallow a previous entry.
	for (const m of plain.matchAll(/([^\n。『」]{0,60}?)[（(](\d{4})[a-z]?[）)]\s*『([^』]{2,90})』/g)) {
		const title = m[3].trim();
		if (!SGU_LING_RE.test(title)) continue;
		const key = normTitle(title);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		const author = m[1]
			.replace(/^[\s\d.．、，)）]+/, '')
			.replace(/[、,\s（(]+$/, '')
			.trim();
		out.push({
			source: 'sgu',
			externalId: `sgu-${key.slice(0, 48)}`,
			doi: null,
			title,
			year: Number(m[2]),
			type: /辞[書典]|辞書|dictionary/i.test(title) ? 'grammar-book' : 'grammar-article',
			rawType: 'sgu-biblio',
			language: 'ja',
			authors: author ? [author] : [],
			venue: null,
			url: SGU_URL,
			pdf: null
		});
	}
	console.log(`  SGU bibliography: +${out.length}`);
	return out;
}

async function main() {
	if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
	console.log('Collecting OpenAlex (Ainu × Linguistics)…');
	const openalex = await collectOpenAlex();
	console.log('Collecting OpenAlex (native-script CJK linguistics)…');
	const openalexNative = await collectOpenAlexNative();
	console.log('Chaining OpenAlex citations (bibliographies of found works)…');
	const seedIds = [...openalex, ...openalexNative]
		.map((r) => r.externalId)
		.filter((id) => /^W\d+$/.test(id));
	const openalexChained = await collectOpenAlexChained(seedIds);
	console.log('Chaining OpenAlex forward citations (works that cite found works)…');
	const forwardSeeds = [
		...new Set([
			...seedIds,
			...openalexChained.map((r) => r.externalId).filter((id) => /^W\d+$/.test(id))
		])
	];
	const openalexForward = await collectOpenAlexForwardChained(forwardSeeds);
	console.log('Collecting Crossref (Ainu-titled)…');
	const crossref = await collectCrossref();
	console.log('Collecting CiNii Research (アイヌ語)…');
	const cinii = await collectCiNii();
	console.log('Collecting Open Library (books)…');
	const openlibrary = await collectOpenLibrary();
	console.log('Collecting NDL book catalog (アイヌ語)…');
	const ndl = await collectNDL();
	console.log('Collecting CyberLeninka (Russian)…');
	const cyberleninka = await collectCyberLeninka();
	console.log('Collecting Hosei TOGO (アイヌ語地名/アイヌ語)…');
	const togo = await collectTOGO();
	console.log('Collecting Hokudai hoppodb (Edo Ainu-language sources)…');
	const hoppodb = await collectHoppoDB();
	console.log('Collecting SGU curated bibliography…');
	const sgu = await collectSGU();

	// Merge with cross-source dedup: DOI-bearing records first (OpenAlex,
	// Crossref), then articles (CiNii), then books (Open Library, NDL). Same
	// title across sources collapses to the first (richest) record.
	const all = [
		...openalex,
		...openalexNative,
		...openalexChained,
		...openalexForward,
		...crossref,
		...cinii,
		...openlibrary,
		...ndl,
		...cyberleninka,
		...togo,
		...hoppodb,
		...sgu
	].filter((r) => r.title && r.title.length > 2);
	const seenDoi = new Set<string>();
	const seenTitle = new Set<string>();
	const merged: AcademicRecord[] = [];
	for (const r of all) {
		const d = r.doi?.toLowerCase() ?? null;
		const t = normTitle(r.title);
		if ((d && seenDoi.has(d)) || (t && seenTitle.has(t))) continue;
		if (d) seenDoi.add(d);
		if (t) seenTitle.add(t);
		merged.push(r);
	}

	fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2));
	const bySource = merged.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
	const withDoi = merged.filter((r) => r.doi).length;
	console.log(`\nWrote ${merged.length} records → ${path.relative(process.cwd(), OUT_FILE)}`);
	console.log(`  by source: ${JSON.stringify(bySource)} · with DOI: ${withDoi}`);
	console.log(
		`  (raw: openalex ${openalex.length}, openalex-native ${openalexNative.length}, openalex-chained ${openalexChained.length}, openalex-forward ${openalexForward.length}, crossref ${crossref.length}, cinii ${cinii.length}, togo ${togo.length}, hoppodb ${hoppodb.length}, sgu ${sgu.length})`
	);
}

if (import.meta.main)
	main().catch((e) => {
		console.error(e);
		process.exit(1);
});
