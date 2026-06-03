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
const EDGES_FILE = path.join(OUT_DIR, 'citation-edges.json');
const MAILTO = 'mkpoli@mkpo.li';
const UA = 'ainu-sources-collector/1.0 (https://db.aynu.org; mkpoli@mkpo.li)';
const LINGUISTICS = 'C41895202'; // OpenAlex concept: Linguistics

export interface AcademicRecord {
	source: string; // 'openalex' | 'crossref' | 'cinii' | 'togo' | 'hoppodb' | 'sgu' | ...
	externalId: string;
	doi: string | null;
	title: string;
	year: number | null;
	type: string; // normalized: 'book' | 'article'
	rawType: string;
	language: string | null;
	authors: string[];
	venue: string | null;
	url: string | null; // canonical landing (DOI or OA)
	pdf: string | null; // open-access PDF if any
	category?: string; // 'secondary' (default) | 'primary' (e.g. Edo-period wordlists)
	links?: { type: string; url: string; label?: string | null }[]; // extra typed links (iiif, transcription…)
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
	if (/dissertation|thesis/i.test(t)) return 'thesis';
	if (/book|monograph/i.test(t)) return 'book';
	return 'article';
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

// --- Citation edges among indexed works (the `cites` relation graph) --------
// Build the internal citation network: which OpenAlex works in our index cite
// which OTHER works in our index. Unlike chaining (which fetches thousands of
// out-of-scope cited works to discover new ones), this only reads each indexed
// work's `referenced_works` (a thin select) and keeps an edge A→B iff B is also
// in our index — so it's ~|works|/50 cheap requests, no out-of-scope fetching.
// The result feeds source_relations(type='cites') at seed time. Real data only:
// every edge is an OpenAlex-attested citation between two works we actually hold.
export interface CitationEdge {
	from: string; // OpenAlex id (W…) of the citing work
	to: string; // OpenAlex id (W…) of the cited work
}

export async function collectCitationEdges(oaIds: string[]): Promise<CitationEdge[]> {
	const inIndex = new Set(oaIds.filter((id) => /^W\d+$/.test(id)));
	const edges: CitationEdge[] = [];
	const ids = [...inIndex];
	let done = 0;
	for (const batch of chunk(ids, CHAIN_CHUNK)) {
		const url =
			`https://api.openalex.org/works?filter=ids.openalex:${batch.join('|')}` +
			`&per-page=${batch.length}&select=id,referenced_works&mailto=${MAILTO}`;
		let data: any;
		try {
			data = await jget(url);
		} catch {
			done += batch.length;
			continue;
		}
		for (const w of data.results ?? []) {
			const from = String(w.id).replace('https://openalex.org/', '');
			for (const r of w.referenced_works ?? []) {
				const to = String(r).replace('https://openalex.org/', '');
				if (to !== from && inIndex.has(to)) edges.push({ from, to });
			}
		}
		done += batch.length;
		console.log(`  citation edges: ${done}/${ids.length} works probed, ${edges.length} in-index edges`);
	}
	return edges;
}

// Regenerate scripts/data/citation-edges.json from the current academic index.
// Standalone (bun collect-academic.ts edges) so it can be refreshed without a
// full — slow, flaky — collector run.
export async function writeCitationEdges(): Promise<number> {
	const recs: AcademicRecord[] = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
	const oaIds = recs.filter((r) => r.source === 'openalex').map((r) => r.externalId);
	console.log(`Building citation graph from ${oaIds.length} OpenAlex works in the index…`);
	const edges = await collectCitationEdges(oaIds);
	fs.writeFileSync(EDGES_FILE, JSON.stringify(edges, null, 2));
	console.log(`Wrote ${edges.length} citation edges → ${path.relative(process.cwd(), EDGES_FILE)}`);
	return edges.length;
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
const CROSSREF_QUERIES = [
	'Ainu language', 'Ainu grammar', 'Ainu dialect', 'Ainu phonology', 'Ainu folklore',
	'Ainu verb', 'Ainu yukar', 'Sakhalin Ainu', 'Ainu toponymy', 'Ainu morphology', 'Ainu syntax'
];
export async function collectCrossref(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const ROWS = 100; // Crossref rejects larger page sizes here
	for (const query of CROSSREF_QUERIES)
	for (let offset = 0; offset < 500; offset += ROWS) {
		const url =
			`https://api.crossref.org/works?query=${encodeURIComponent(query)}` +
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
			if (!/ainu/i.test(title) || !w.DOI || seen.has(w.DOI)) continue; // title precision + dedup
			seen.add(w.DOI);
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
	'アイヌ語', 'アイヌ語 方言', 'アイヌ語 文法', 'アイヌ語 音韻',
	'アイヌ民族文化研究センター研究紀要',
	// topic / genre / dialect facets to reach works past the per-query result cap
	'アイヌ語 動詞', 'アイヌ語 人称', 'アイヌ語 名詞', 'アイヌ語 語彙', 'アイヌ語 辞典',
	'アイヌ語 地名', 'アイヌ語 アクセント', 'アイヌ語 構文', 'アイヌ語 テキスト',
	'アイヌ語 千歳', 'アイヌ語 沙流', 'アイヌ語 静内', 'アイヌ語 樺太', 'アイヌ語 北海道',
	'アイヌ 神謡', 'アイヌ ユーカラ', 'アイヌ 口承文芸', 'アイヌ 昔話', 'アイヌ 散文説話',
	'アイヌ 叙事詩', 'アイヌ 伝承', '蝦夷 言葉', '蝦夷 語彙', 'アイヌ語 教育'
];

export async function collectCiNii(): Promise<AcademicRecord[]> {
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
					type: 'article',
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
const OL_QUERIES = [
	'Ainu language', 'Ainu grammar', 'Ainu dictionary', 'Ainu folklore', 'Ainu folk-tales',
	'Ainu vocabulary', 'Ainu yukar', 'Ainu texts', 'Aino language', 'Sakhalin Ainu', 'Ainu place names'
];

export async function collectOpenLibrary(): Promise<AcademicRecord[]> {
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
					type: 'book',
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
const NDL_QUERIES = [
	'アイヌ語', 'アイヌ 辞典', 'アイヌ 文法', 'アイヌ 地名', 'アイヌ 神謡', 'アイヌ ユーカラ',
	'アイヌ 説話', 'アイヌ 物語', 'アイヌ 民話', 'アイヌ 会話', 'アイヌ 語彙', 'アイヌ 口承',
	'アイヌ 樺太', 'アイヌ 方言', '蝦夷語', '蝦夷方言', '蝦夷 詞'
];
export async function collectNDL(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const cdata = (s: string) => s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
	for (const term of NDL_QUERIES)
	for (let idx = 1; idx <= 600; idx += 200) {
		const url =
			`https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(term)}` +
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
			if (!title || !/アイヌ|ainu|蝦夷[語方詞]|あいぬ/i.test(title)) continue;
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
				type: 'book',
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
const CL_QUERIES = [
	'айнский язык', 'айнского языка', 'сахалинские айны язык', 'язык айнов',
	'айнский фольклор', 'айнские топонимы', 'айны Сахалин', 'айнская лексика'
];

export async function collectCyberLeninka(): Promise<AcademicRecord[]> {
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
				// Drop Tajik titles: Tajik-only Cyrillic (Ҳ/Ӣ/Ӯ/Ҷ/Ғ/Қ) or таджик — they
				// slip in via "Айнӣ" (Sadriddin Aini, the Tajik writer) matching "айн".
				if (!title || /[ҲҳӢӣӮӯҶҷҒғҚқ]|таджик/i.test(title)) continue;
				if (!/айн/i.test(title)) continue;
				// Require a language/linguistics/folklore marker — the broad queries
				// otherwise admit Ainu material-culture papers (айнского меча…).
				if (!/язык|лингв|лексик|топоним|фольклор|диалект|граммати|фонетик|фонолог|словар|речь|\bтекст|устн|сказани|эпос|глагол|морфолог|синтакс|письмен|наречи|говор|перевод/i.test(title))
					continue;
				const id = a.link || title;
				if (seen.has(id)) continue;
				seen.add(id);
				out.push({
					source: 'cyberleninka',
					externalId: id,
					doi: null,
					title,
					year: Number(a.year) || null,
					type: 'article',
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
					type: 'article',
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
				type: 'book',
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
			type: /辞[書典]|辞書|dictionary/i.test(title) ? 'book' : 'article',
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

// --- みんなで翻刻 (Honkoku) — ongoing crowdsourced transcription project --------
// The "アイヌ関連資料" project: Edo-period Ainu manuscripts being transcribed by
// volunteers. Each entry has an IIIF manifest (the digitised original at its
// holding library) + a Honkoku transcription workspace. We emit one PRIMARY
// record per entry carrying BOTH links; seedAcademic grafts them onto the
// matching original book (e.g. the 藻汐草 we already hold) via coreKey, realising
// "link the transcriptions with the original books".
const HONKOKU_KEY = 'AIzaSyB-n5klhtxCtVmJqcsnhIc7-bWj5Ou--GY';
const HONKOKU_FS =
	`https://firestore.googleapis.com/v1/projects/honkoku3-c466c/databases/(default)/documents:runQuery?key=${HONKOKU_KEY}`;

const fsStr = (f: any): string | null => f?.stringValue ?? null;

// Pull author + year out of an IIIF manifest (v2 label/value or v3 language maps).
async function iiifAuthorYear(manifestUrl: string): Promise<{ author: string | null; year: number | null }> {
	let m: any;
	try {
		m = await jget(manifestUrl);
	} catch {
		return { author: null, year: null };
	}
	const meta: any[] = m.metadata ?? [];
	const flat = (v: any): string => {
		if (v == null) return '';
		if (typeof v === 'string') return v;
		if (Array.isArray(v)) return v.map(flat).find(Boolean) ?? '';
		if (typeof v === 'object') return flat(v['@value'] ?? v.ja ?? v.en ?? v.none ?? Object.values(v)[0]);
		return String(v);
	};
	const pick = (re: RegExp): string | null => {
		for (const e of meta) if (re.test(flat(e.label))) {
			const s = flat(e.value).replace(/<[^>]+>/g, '').trim();
			if (s) return s;
		}
		return null;
	};
	const dateStr = pick(/date|year|年|刊年|成立|和暦|西暦/i) ?? '';
	return { author: pick(/author|creator|著者|作者|編者|筆者/i), year: Number((dateStr.match(/\d{4}/) ?? [])[0]) || null };
}

export async function collectHonkoku(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	let docs: any[];
	try {
		const res = await fetch(HONKOKU_FS, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
			body: JSON.stringify({
				structuredQuery: {
					from: [{ collectionId: 'entries' }],
					where: { fieldFilter: { field: { fieldPath: 'projectId' }, op: 'EQUAL', value: { stringValue: 'ainu' } } }
				}
			})
		});
		docs = ((await res.json()) as any[]).filter((r) => r?.document);
	} catch {
		return out;
	}
	for (const r of docs) {
		const f = r.document.fields;
		const id = String(r.document.name).split('/').pop()!;
		const title = (fsStr(f.label) ?? '')
			.replace(/[（(][^）)]*[)）]\s*$/, '') // drop trailing （holding library）
			.replace(/[\s　]+/g, ' ')
			.trim();
		if (!title) continue;
		const manifest = fsStr(f.manifestUrl);
		const holding = fsStr(f.attribution);
		const { author, year } = manifest ? await iiifAuthorYear(manifest) : { author: null, year: null };
		const links: { type: string; url: string; label?: string | null }[] = [
			{ type: 'transcription', url: `https://app.honkoku.org/reader/${id}`, label: 'みんなで翻刻' }
		];
		if (manifest) links.push({ type: 'iiif', url: manifest, label: holding && !/^https?:/.test(holding) ? holding : 'IIIF manifest' });
		out.push({
			source: 'honkoku',
			externalId: id,
			doi: null,
			title,
			year,
			type: 'book',
			rawType: 'honkoku-entry',
			language: 'ja',
			authors: author ? [author] : [],
			venue: holding && !/^https?:/.test(holding) ? holding : null,
			url: null,
			pdf: null,
			category: 'primary',
			links
		});
	}
	console.log(`  Honkoku (みんなで翻刻 アイヌ関連資料): +${out.length}`);
	return out;
}

// --- NIJL 国書データベース (Kokusho) IIIF — 蝦夷/Ainu language materials --------
// Edo-period Ainu-language manuscripts & prints with IIIF images. We hit the
// (undocumented) biblioSimpleSearch API on the language-specific slice, keep
// IIIF-bearing items only, and emit PRIMARY records whose IIIF manifest grafts
// onto the matching original (蝦夷方言藻汐草, 蝦夷語集…) via coreKey.
const KOKUSHO_API = 'https://kokusho.nijl.ac.jp/api/biblioSimpleSearch?keyword=';
const KOKUSHO_QUERIES = [
	'蝦夷語', '蝦夷方言', 'アイヌ語', '藻汐草', '蝦夷詞', '夷語', '蝦夷言葉',
	'蝦夷語集', '夷言', '蝦夷会話', '通辞'
];
// Require BOTH an Ezo/Ainu marker AND a language marker — 藻汐草 alone is a generic
// poetic title (佐州怪談藻汐草, 藻塩艸 …) and 蝦夷 alone admits geography/maps.
const KOKUSHO_AINU_RE = /蝦夷|夷|アイヌ|愛努/;
const KOKUSHO_LANG_RE = /語|方言|言葉|夷言|詞|ことば|単語|和解|対話|訳|俗話|会話|藻汐草/;
const KOKUSHO_SKIP_RE = /図|圖|地図|絵巻|絵図|風俗/; // maps / picture-scrolls are out of scope

export async function collectKokusho(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seenWork = new Set<string>(); // one IIIF witness per work (else 10× 蝦夷語箋)
	for (const q of KOKUSHO_QUERIES) {
		let arr: any[];
		try {
			arr = await jget(KOKUSHO_API + encodeURIComponent(q));
		} catch {
			continue;
		}
		let kept = 0;
		for (const it of Array.isArray(arr) ? arr : []) {
			const bid = String(it.bid ?? '');
			if (!bid) continue;
			if (String(it.image) !== '1') continue; // IIIF only
			const name = String(it.name ?? '').replace(/／/g, ' ').replace(/\s+/g, ' ').trim();
			if (!name || KOKUSHO_SKIP_RE.test(name)) continue;
			const hay = `${name} ${it.wname ?? ''} ${it.wkeyword ?? ''}`;
			if (!KOKUSHO_AINU_RE.test(name) || !KOKUSHO_LANG_RE.test(hay)) continue;
			const work = String(it.wid ?? bid);
			if (seenWork.has(work)) continue;
			seenWork.add(work);
			const authors = (Array.isArray(it.authorlist) ? it.authorlist : [])
				.map((a: string) => String(a).replace(/／/g, ' ').trim())
				.filter(Boolean);
			const year = Number((String(it.syear ?? it.wyear ?? '').match(/\d{4}/) ?? [])[0]) || null;
			out.push({
				source: 'kokusho',
				externalId: bid,
				doi: null,
				title: name,
				year,
				type: 'book',
				rawType: it.kansha === '写' ? 'manuscript' : 'kokusho-record',
				language: 'ja',
				authors,
				venue: it.collection ?? null,
				url: null,
				pdf: null,
				category: 'primary',
				links: [
					{ type: 'iiif', url: `https://kokusho.nijl.ac.jp/biblio/${bid}/manifest`, label: it.collection ?? 'NIJL 国書DB' },
					{ type: 'website', url: `https://kokusho.nijl.ac.jp/biblio/${bid}`, label: '国書データベース' }
				]
			});
			kept += 1;
		}
		console.log(`  Kokusho "${q}": +${kept} (total ${out.length})`);
	}
	return out;
}

// --- Hugging Face — Ainu-language NLP models & datasets ---------------------
// Yasuoka's UD/POS models, aynumosir's mt5/gpt2-ainu, AinuTrans, byt5 latinizers,
// TTS… The "ainu" token must be a real language designator: `ainu` delimited by
// -_/. or followed by "trans" — this excludes the many decoys (Ainur, AINurse,
// ai-nuclear, …) whose ids merely contain the substring.
const HF_AINU_RE = /(^|[-_/])ainu(trans|[-_/.]|$)/i;
export async function collectHuggingFace(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const kind of ['models', 'datasets']) {
		let arr: any[];
		try {
			arr = await jget(`https://huggingface.co/api/${kind}?search=ainu&limit=200`);
		} catch {
			continue;
		}
		for (const m of Array.isArray(arr) ? arr : []) {
			const id = String(m.id ?? m.modelId ?? '');
			if (!id || seen.has(id) || !HF_AINU_RE.test(id)) continue;
			seen.add(id);
			const org = id.split('/')[0];
			const repo = id.split('/')[1] ?? id;
			out.push({
				source: 'huggingface',
				externalId: id,
				doi: null,
				title: repo,
				year: Number(String(m.createdAt ?? '').slice(0, 4)) || null,
				type: kind === 'datasets' ? 'reference' : 'software',
				rawType: kind === 'datasets' ? 'hf-dataset' : 'hf-model',
				language: 'ain',
				authors: org ? [org] : [],
				venue: kind === 'datasets' ? 'Hugging Face dataset' : 'Hugging Face model',
				url: null,
				pdf: null,
				category: 'tool',
				links: [
					{
						type: 'huggingface',
						url: `https://huggingface.co/${kind === 'datasets' ? 'datasets/' : ''}${id}`,
						label: 'Hugging Face'
					}
				]
			});
		}
	}
	console.log(`  Hugging Face (Ainu models/datasets): +${out.length}`);
	return out;
}

// --- Qiita — アイヌ語 technical articles (NLP/OCR/UD, mostly 安岡孝一) -----------
const QIITA_QUERIES = ['アイヌ語', '蝦夷語'];
export async function collectQiita(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const q of QIITA_QUERIES) {
		let arr: any[];
		try {
			arr = await jget(`https://qiita.com/api/v2/items?query=${encodeURIComponent(q)}&per_page=100`);
		} catch {
			continue;
		}
		for (const it of Array.isArray(arr) ? arr : []) {
			const title = String(it.title ?? '').trim();
			const id = String(it.id ?? '');
			if (!title || !id || seen.has(id) || !/アイヌ|蝦夷|ainu/i.test(title)) continue;
			seen.add(id);
			out.push({
				source: 'qiita',
				externalId: id,
				doi: null,
				title,
				year: Number(String(it.created_at ?? '').slice(0, 4)) || null,
				type: 'website',
				rawType: 'qiita-article',
				language: 'ja',
				authors: it.user?.id ? [it.user.id] : [],
				venue: 'Qiita',
				url: null,
				pdf: null,
				category: 'tool',
				links: [{ type: 'website', url: it.url ?? `https://qiita.com/items/${id}`, label: 'Qiita' }]
			});
		}
	}
	console.log(`  Qiita (アイヌ語 articles): +${out.length}`);
	return out;
}

// ===========================================================================
// Extra collectors (2026-06 expansion) — discovered via parallel recon.
// Each was probed against the live API before implementation. All are
// linguistics-scoped and expose a stable dedup key (DOI, NCID, handle, ref id).
// ===========================================================================

// Small regex helpers for the XML/RSS sources below.
const xmlFirst = (block: string, tag: string): string | null => {
	const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
	return m ? m[1] : null;
};
const decodeEntities = (s: string): string =>
	s
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, '&')
		.trim();
// Decode entities/CDATA FIRST, then strip real tags — otherwise stripTags eats
// a whole <![CDATA[…]]> block (no '>' inside) and the text vanishes.
const cleanText = (s: string | null | undefined): string => stripTags(decodeEntities(String(s ?? ''))).replace(/\s+/g, ' ').trim();

// --- J-STAGE — Japanese journal & 紀要 articles (service=3, full-text) -------
// 1,490 hits for アイヌ語; every record carries a prism:doi. Full-text search
// dilutes past the first pages, so we KEEP a record only when its title says
// アイヌ/Ainu OR it sits in a linguistics-journal allowlist. Atom+PRISM XML.
const JSTAGE_QUERIES = [
	'アイヌ語', 'アイヌ語 方言', 'アイヌ語 文法', 'アイヌ語 地名', 'アイヌ語 音韻',
	'アイヌ語 動詞', 'アイヌ語 語彙', 'アイヌ語 人称', 'アイヌ 樺太', 'アイヌ 千歳',
	'アイヌ 沙流', 'ユーカラ アイヌ', 'アイヌ 口承', 'アイヌ語 辞典',
	'アイヌ語 名詞', 'アイヌ語 アクセント', 'アイヌ語 構文', 'アイヌ語 静内',
	'アイヌ語 アスペクト', 'アイヌ語 使役', 'アイヌ 神謡', 'アイヌ 昔話',
	'アイヌ語 教育', 'アイヌ語 継承', 'アイヌ語 借用', 'アイヌ語 比較', '蝦夷 言葉'
];
// J-STAGE journal codes (cdjournal) that are linguistics / Ainu venues — a hit
// in one of these is kept even if the title regex is borderline.
const JSTAGE_LING_JOURNALS = new Set([
	'gengo', 'gengo1939', 'hlj', 'jajls', 'namjournal', 'jnlp', 'nihongkenkyu', 'jslp'
]);
export async function collectJStage(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const COUNT = 100;
	for (const q of JSTAGE_QUERIES) {
		for (let start = 1; start <= 600; start += COUNT) {
			const url =
				`https://api.jstage.jst.go.jp/searchapi/do?service=3&text=${encodeURIComponent(q)}` +
				`&start=${start}&count=${COUNT}`;
			let xml: string;
			try {
				xml = await htext(url);
			} catch {
				break;
			}
			const entries = xml.split('<entry>').slice(1);
			if (!entries.length) break;
			let kept = 0;
			for (const e of entries) {
				const titleBlock = xmlFirst(e, 'article_title') ?? '';
				const titleJa = cleanText(xmlFirst(titleBlock, 'ja'));
				const titleEn = cleanText(xmlFirst(titleBlock, 'en'));
				// Strip 体育学会-style conference session codes that prefix proceedings
				// titles ("124 共 A20702 …", "90A10805 …", "121X08 …") — a leading
				// number + optional session marker + a LETTER+digits code. Year/century
				// openers ("19世紀…", "1822年…") have no [A-Z]\d code, so survive.
				const stripCode = (t: string) => t.replace(/^\d{1,4}\s*(?:[共一専般]\s*)?[A-Z]\d{2,6}\s+/, '').trim();
				const title = stripCode(titleJa || titleEn);
				if (!title) continue;
				const cdjournal = cleanText(xmlFirst(e, 'cdjournal'));
				// Scope: Ainu in title (ja or en), or an allowlisted linguistics venue.
				const onTopic = /アイヌ|ainu|ユーカラ|樺太/i.test(`${titleJa} ${titleEn}`);
				if (!onTopic && !JSTAGE_LING_JOURNALS.has(cdjournal)) continue;
				// even venue-allowlisted hits must mention Ainu somewhere to stay in-scope
				if (!/アイヌ|ainu|ユーカラ|yukar|樺太|sakhalin/i.test(`${titleJa} ${titleEn}`)) continue;
				const doi = cleanText(xmlFirst(e, 'prism:doi')) || null;
				const id = doi || cleanText(xmlFirst(e, 'id'));
				if (!id || seen.has(id)) continue;
				seen.add(id);
				const matBlock = xmlFirst(e, 'material_title') ?? '';
				const venue = cleanText(xmlFirst(matBlock, 'ja')) || cleanText(xmlFirst(matBlock, 'en')) || null;
				const authBlock = xmlFirst(e, 'author') ?? '';
				const authJa = xmlFirst(authBlock, 'ja') ?? '';
				const authEn = xmlFirst(authBlock, 'en') ?? '';
				const authors = [...(authJa.match(/<name>[\s\S]*?<\/name>/g) ?? [])].map((n) => cleanText(n)).filter(Boolean);
				const authorsEn = [...(authEn.match(/<name>[\s\S]*?<\/name>/g) ?? [])].map((n) => cleanText(n)).filter(Boolean);
				const linkJa = cleanText(xmlFirst(xmlFirst(e, 'article_link') ?? '', 'ja'));
				const yearStr = cleanText(xmlFirst(e, 'pubyear'));
				out.push({
					source: 'jstage',
					externalId: doi || linkJa || id,
					doi,
					title,
					year: /^\d{4}$/.test(yearStr) ? Number(yearStr) : null,
					type: 'article',
					rawType: 'article',
					language: titleJa ? 'ja' : 'en',
					authors: authors.length ? authors : authorsEn,
					venue,
					url: doi ? `https://doi.org/${doi}` : linkJa || null,
					pdf: null
				});
				kept++;
			}
			console.log(`  J-STAGE "${q}" start ${start}: +${kept} (total ${out.length})`);
			if (entries.length < COUNT) break;
		}
	}
	return out;
}

// --- CiNii Books — Japanese academic books / serials (NCID) -----------------
// 929 hits; no DOI (dedup by NCID + normalized title). The OpenSearch summary
// lacks the year, so we fetch the per-record .json (throttled) for survivors.
const CINII_BOOKS_QUERIES = ['アイヌ語', 'アイヌ 地名', 'アイヌ 神謡', 'アイヌ 民話', '蝦夷 語'];
export async function collectCiNiiBooks(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const COUNT = 200;
	for (const term of CINII_BOOKS_QUERIES)
	for (let p = 1; p <= 5; p++) {
		const url =
			`https://ci.nii.ac.jp/books/opensearch/search?q=${encodeURIComponent(term)}` +
			`&format=json&count=${COUNT}&p=${p}`;
		let data: any;
		try {
			data = await jget(url);
		} catch {
			break;
		}
		const items = data['@graph']?.[0]?.items ?? [];
		if (!items.length) break;
		for (const it of items) {
			const title = String(it.title ?? '').trim();
			if (!title || !/アイヌ|ainu|蝦夷[語方詞]/i.test(title)) continue;
			const ncid = String(it['@id'] ?? '').replace('https://ci.nii.ac.jp/ncid/', '');
			if (!ncid || seen.has(ncid)) continue;
			seen.add(ncid);
			const creators = Array.isArray(it['dc:creator']) ? it['dc:creator'] : it['dc:creator'] ? [it['dc:creator']] : [];
			out.push({
				source: 'cinii-books',
				externalId: ncid,
				doi: null,
				title,
				year: null,
				type: 'book',
				rawType: 'book',
				language: 'ja',
				authors: creators.map((c: any) => String(c).trim()).filter(Boolean),
				venue: null,
				url: String(it['@id'] ?? `https://ci.nii.ac.jp/ncid/${ncid}`),
				pdf: null
			});
		}
		console.log(`  CiNii Books p${p}: total ${out.length}`);
		if (items.length < COUNT) break;
	}
	return out;
}

// Fill the year (and refine language) for kept CiNii Books records from the
// per-NCID detail JSON. Called post-dedup so we only fetch survivors.
async function enrichCiNiiBooks(records: AcademicRecord[]): Promise<void> {
	let done = 0;
	for (const r of records) {
		try {
			const d = await jget(`https://ci.nii.ac.jp/ncid/${r.externalId}.json`);
			const g = d['@graph']?.find((x: any) => x['dc:date'] || x['prism:publicationDate']) ?? d['@graph']?.[0] ?? {};
			const date = g['dc:date'] ?? g['prism:publicationDate'] ?? '';
			const ym = String(Array.isArray(date) ? date[0] : date).match(/\d{4}/);
			if (ym) r.year = Number(ym[0]);
		} catch {
			/* leave year null */
		}
		if (++done % 50 === 0) console.log(`  CiNii Books year enrich: ${done}/${records.length}`);
	}
}

// --- IRDB — Japanese institutional repositories (NII aggregator) ------------
// 607 hits for アイヌ語; RSS2.0. No DOI in the feed (handle/URI is the key). We
// keep linguistics titles and drop ritual/genetics/archaeology/policy items.
const IRDB_KEEP_RE =
	/アイヌ語|方言|文法|語彙|音韻|音声|地名|口承|ユカ[ㇻラ]|ユーカラ|神謡|叙事詩|筆録|口述|昔話|民話|カムイユカ|ウエペケ|辞典|辞書|menoko|yukar|loanword|passive|dialect|toponym|grammar|phonolog|受動|人称|証拠性|否定|敬語|アクセント|韻律/i;
const IRDB_DROP_RE =
	/儀礼|祭祀|遺跡|DNA|ゲノム|遺伝|観光|政策|ヤサーク|賦課|考古|裁判|アイデンティティ|先住民族の包摂|林業|農業|経済|看護|保健/i;
const IRDB_TYPE: Record<string, string> = {
	'Thesis': 'thesis', 'Doctoral Thesis': 'thesis', 'Book': 'book', 'Article': 'article',
	'Journal Article': 'article', 'Departmental Bulletin Paper': 'article', 'Conference Paper': 'article',
	'Learning Material': 'article', 'Research Paper': 'article'
};
export async function collectIRDB(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const COUNT = 100;
	for (const q of ['アイヌ語', 'アイヌ 方言', 'アイヌ 口承']) {
		for (let start = 1; start <= 800; start += COUNT) {
			const url = `https://irdb.nii.ac.jp/opensearch/search?q=${encodeURIComponent(q)}&count=${COUNT}&start=${start}`;
			let xml: string;
			try {
				xml = await htext(url);
			} catch {
				break;
			}
			const items = xml.split('<item>').slice(1);
			if (!items.length) break;
			for (const it of items) {
				const title = cleanText(xmlFirst(it, 'title'));
				if (!title) continue;
				if (!IRDB_KEEP_RE.test(title) || IRDB_DROP_RE.test(title)) continue;
				const uri = cleanText(xmlFirst(it, 'URI'));
				const link = cleanText(xmlFirst(it, 'link'));
				const key = uri || link;
				if (!key || seen.has(key)) continue;
				seen.add(key);
				const cat = cleanText(xmlFirst(it, 'category'));
				const pub = cleanText(xmlFirst(it, 'pubDate'));
				const ym = pub.match(/\d{4}/);
				// Each <author> tag is ONE person in "Surname, Given" form (中川, 裕 =
				// Nakagawa Hiroshi). Co-authors get their own tags. Do NOT split on the
				// comma — it separates surname from given, not co-authors — keep it so
				// the seed's parsePersonName resolves "姓, 名" → "姓 名".
				const authors = [...it.matchAll(/<author>([\s\S]*?)<\/author>/g)]
					.map((m) => cleanText(m[1]))
					.filter(Boolean);
				out.push({
					source: 'irdb',
					externalId: key,
					doi: null,
					title,
					year: ym ? Number(ym[0]) : null,
					type: IRDB_TYPE[cat] ?? 'article',
					rawType: cat || 'article',
					language: 'ja',
					authors,
					venue: cleanText(xmlFirst(it, 'irname')) || null,
					url: uri || link,
					pdf: null
				});
			}
			console.log(`  IRDB "${q}" start ${start}: total ${out.length}`);
			if (items.length < COUNT) break;
		}
	}
	return out;
}

// --- Crossref — edited-volume chapters (ISBN / container enumeration) -------
// Free-text Crossref is relevance-ranked; the clean way to get the blind-spot
// chapters (whose titles lack "Ainu") is to enumerate by ISBN / container of
// the landmark Ainu-linguistics volumes. Every record carries a DOI.
const CROSSREF_AINU_ISBNS = [
	'9788869698613', // Dal Corso, Ainu grammar (Ca' Foscari, 2024)
	'9788869698620', // …2025 edition
	'9788869695858' // Bugaeva et al., Materials & Methods (Ca' Foscari, 2022)
];
const CROSSREF_AINU_CONTAINERS = [
	'Handbook of the Ainu Language' // clean, substantive linguistics chapters
];
const CHAPTER_FRONTMATTER_RE =
	/^(front\s?matter|back\s?matter|frontmatter|table of contents|contents|preface|introduction to|index|subject index|author index|list of (contributors|illustrations|abbreviations)|contributors|copyright|title pages?|plate|illustration|map\b)/i;
export async function collectCrossrefChapters(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const emit = (w: any, forceAinu: boolean) => {
		const title = (w.title?.[0] ?? '').trim();
		if (!title) return;
		if (CHAPTER_FRONTMATTER_RE.test(title)) return;
		// container-enumerated volumes are all in-scope; free-text needs the Ainu gate
		if (!forceAinu && !/ainu/i.test(title)) return;
		const doi = w.DOI;
		if (!doi || seen.has(doi)) return;
		seen.add(doi);
		out.push({
			source: 'crossref',
			externalId: doi,
			doi,
			title,
			year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
			type: normType(w.type ?? 'book-chapter'),
			rawType: w.type ?? 'book-chapter',
			language: null,
			authors: (w.author ?? [])
				.map((a: any) => [a.given, a.family].filter(Boolean).join(' ').trim())
				.filter(Boolean),
			venue: w['container-title']?.[0] ?? null,
			url: `https://doi.org/${doi}`,
			pdf: null
		});
	};
	// 1) ISBN enumeration — every chapter of the landmark Ainu grammar volumes.
	for (const isbn of CROSSREF_AINU_ISBNS) {
		const url = `https://api.crossref.org/works?filter=type:book-chapter,isbn:${isbn}&rows=100&select=DOI,title,author,issued,type,container-title&mailto=${MAILTO}`;
		try {
			const data = await jget(url);
			for (const w of data.message?.items ?? []) emit(w, true);
			console.log(`  Crossref ISBN ${isbn}: total ${out.length}`);
		} catch {
			/* skip */
		}
	}
	// 2) Container enumeration — top chapters of the Ainu volumes, frontmatter dropped.
	for (const c of CROSSREF_AINU_CONTAINERS) {
		const url = `https://api.crossref.org/works?query.container-title=${encodeURIComponent(c)}&filter=type:book-chapter&rows=80&select=DOI,title,author,issued,type,container-title&mailto=${MAILTO}`;
		try {
			const data = await jget(url);
			for (const w of data.message?.items ?? []) {
				const cont = (w['container-title']?.[0] ?? '').toLowerCase();
				if (!/ainu/i.test(cont)) continue; // only chapters actually in an Ainu volume
				emit(w, true);
			}
			console.log(`  Crossref container "${c}": total ${out.length}`);
		} catch {
			/* skip */
		}
	}
	// 3) Free-text book-chapters with "Ainu" in the title (catches standalone chapters).
	try {
		const url = `https://api.crossref.org/works?query=${encodeURIComponent('Ainu')}&filter=type:book-chapter&rows=300&select=DOI,title,author,issued,type,container-title&mailto=${MAILTO}`;
		const data = await jget(url);
		for (const w of data.message?.items ?? []) emit(w, false);
		console.log(`  Crossref free-text chapters: total ${out.length}`);
	} catch {
		/* skip */
	}
	return out;
}

// --- Glottolog — curated Ainu reference bibliography (langdoc.csv) ----------
// The family-root export (language=ainu1252) returns the full 108-ref superset.
// Already-curated & language-scoped; we filter by hhtype to keep linguistics.
const GLOTTOLOG_KEEP_HHTYPE = new Set([
	'dictionary', 'grammar', 'grammar_sketch', 'phonology', 'comparative', 'text',
	'wordlist', 'dialectology', 'specific_feature', 'minimal', 'wordlist_or_less',
	'overview', 'new_testament', 'bible'
]);
function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let q = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (q) {
			if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
			else if (ch === '"') q = false;
			else cur += ch;
		} else if (ch === '"') q = true;
		else if (ch === ',') { out.push(cur); cur = ''; }
		else cur += ch;
	}
	out.push(cur);
	return out;
}
const deLatex = (s: string): string =>
	s.replace(/\\(?:emph|textit|textbf|zh|ja|url|href)\{([^}]*)\}/g, '$1').replace(/[{}]/g, '').replace(/\\[a-z]+/gi, '').trim();
export async function collectGlottolog(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	let csv: string;
	try {
		csv = await htext('https://glottolog.org/langdoc.csv?language=ainu1252');
	} catch {
		console.log('  Glottolog: fetch failed');
		return out;
	}
	const lines = csv.split(/\r?\n/).filter((l) => l.trim());
	const header = parseCsvLine(lines[0]);
	const col = (row: string[], name: string) => {
		const i = header.indexOf(name);
		return i >= 0 ? row[i] : '';
	};
	for (const line of lines.slice(1)) {
		const row = parseCsvLine(line);
		const id = col(row, 'id');
		const titleRaw = col(row, 'title');
		if (!id || !titleRaw) continue;
		if (/^personal communication$/i.test(titleRaw.trim())) continue; // bib stub, not a work
		let hhtype = '';
		let titleEnglish = '';
		try {
			const jd = JSON.parse(col(row, 'jsondata') || '{}');
			hhtype = jd.hhtype ?? '';
			titleEnglish = jd.title_english ?? '';
		} catch {
			/* ignore */
		}
		// keep only linguistics document types (ethnographic etc. excluded)
		if (hhtype && !GLOTTOLOG_KEEP_HHTYPE.has(hhtype)) continue;
		const title = deLatex(titleRaw);
		const yearM = (col(row, 'year_int') || col(row, 'year')).match(/\d{4}/);
		const authorRaw = col(row, 'author') || col(row, 'editor');
		const authors = authorRaw
			? authorRaw.split(/\s+and\s+/i).map((a) => a.trim()).filter(Boolean)
			: [];
		const bt = col(row, 'bibtex_type');
		const doiM = (col(row, 'jsondata').match(/"doi":\s*"([^"]+)"/) ?? [])[1];
		out.push({
			source: 'glottolog',
			externalId: id,
			doi: doiM ? doiM.replace(/^https?:\/\/doi\.org\//, '') : null,
			title: titleEnglish && titleEnglish !== title ? `${title} (${titleEnglish})` : title,
			year: yearM ? Number(yearM[0]) : null,
			type: /article|incollection/.test(bt) ? 'article' : /phdthesis|mastersthesis/.test(bt) ? 'thesis' : 'book',
			rawType: bt || hhtype || 'book',
			language: null,
			authors,
			venue: col(row, 'journal') || col(row, 'booktitle') || null,
			url: doiM ? `https://doi.org/${doiM.replace(/^https?:\/\/doi\.org\//, '')}` : `https://glottolog.org/resource/reference/id/${id}`,
			pdf: null
		});
	}
	console.log(`  Glottolog (ainu1252): +${out.length} linguistics refs`);
	return out;
}

// --- OpenAlex — by-author harvest + book-chapter blind spots ----------------
// The keyword collector is title-blind to Ainu chapters in edited volumes and
// to works by core authors whose titles omit "Ainu". We harvest validated Ainu
// linguists' works, keeping only those anchored to an Ainu venue or title, plus
// the linguistics-tagged book-chapters. DOI (or Wid) dedup downstream.
const OPENALEX_AINU_AUTHORS = [
	'A5023827507', // Anna Bugaeva
	'A5083262553', // Hidetoshi Shiraishi
	'A5086749194', // Hideo Kirikae
	'A5006225596', // Elia Dal Corso
	// 田村すゞ子 (Tamura Suzuko) — fragmented across 5 OpenAlex author records
	'A5077536442', 'A5131446470', 'A5131891363', 'A5129631365', 'A5132330564'
];
// Venues (host source display names) that are wholly Ainu-linguistics.
const OPENALEX_AINU_VENUE_RE =
	/handbook of the ainu language|materials and methods.*ainu|ainu language|ca'? foscari japanese studies/i;
export async function collectOpenAlexExtra(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const keep = (w: any) => {
		const id = String(w.id).replace('https://openalex.org/', '');
		if (seen.has(id)) return;
		const title = (w.title ?? w.display_name ?? '').trim();
		const venue = w.primary_location?.source?.display_name ?? '';
		const onTopic = /ainu|アイヌ|sakhalin ainu/i.test(title) || OPENALEX_AINU_VENUE_RE.test(venue);
		if (!onTopic) return;
		if (/^(frontmatter|backmatter|table of contents|contents|preface|index|contributors|subject index)/i.test(title)) return;
		seen.add(id);
		out.push(oaRecord(w));
	};
	// (1) book-chapters whose title contains Ainu + Linguistics concept
	try {
		const url = `https://api.openalex.org/works?filter=title.search:Ainu,type:book-chapter,concepts.id:${LINGUISTICS}&per-page=200&mailto=${MAILTO}`;
		for (const w of (await jget(url)).results ?? []) keep(w);
		console.log(`  OpenAlex chapters: total ${out.length}`);
	} catch {
		/* skip */
	}
	// (2) by-author harvest, venue/title-gated to avoid polymath dilution
	for (const aid of OPENALEX_AINU_AUTHORS) {
		try {
			const url = `https://api.openalex.org/works?filter=author.id:${aid}&per-page=200&select=id,display_name,title,doi,publication_year,type,primary_location,authorships,concepts,primary_topic,best_oa_location&mailto=${MAILTO}`;
			for (const w of (await jget(url)).results ?? []) keep(w);
			console.log(`  OpenAlex author ${aid}: total ${out.length}`);
		} catch {
			/* skip */
		}
	}
	return out;
}

// --- researchmap — an individual researcher's own Ainu-linguistics output -----
// Follows a researcher's researchmap profile (published_papers + books + misc)
// and keeps their Ainu-language works. Reusable for any researcher we hold a
// permalink for; their works link to them as author at seed time.
// Verified researchmap permalinks of Ainu-studies researchers (their non-Ainu
// works are dropped by the title filter). Keep in sync with persons.researchmap.
const RESEARCHMAP_PERMALINKS = [
	'SAKAGUCHI_Ryo', 'ainlingsat', 'read0064265', 'read0012388', 'read0144912',
	'read0049566', 'read0021678', 'mkfk', 'osaka_taku', 'ono_yohei',
	'tangikuitsuji', 'kobayashi_miki', 'y.yoshikawa', '1976', 'hacrc_hm',
	'read0127694', 'read0119850', 'koji_yamasaki', 'SoMiyagawa', 'read0067315', 'yocjyet',
	// discovered 2026-06-02 (verified via api.researchmap.jp): linguistics / oral-lit
	'iii', 'utari', 'read0131605', 'akemi6oshino', 'mfujita1023',
	'ksmtyshs', 'read0131604', 'takuya_inoue', '_retar', 'uchida_junko0069',
	// round 2 (2026-06-02): typology + place-names + Ainu-NLP/documentation
	'read0015553', 'read0166431', 'ptaszynski', 'read0021800', 'read0021804', 'nakagawanatuko'
];
export async function collectResearchmap(permalinks: string[]): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const titleOf = (it: any): { ja: string; en: string } => {
		const t = it.paper_title ?? it.book_title ?? it.misc_title ?? it.presentation_title ?? it.title;
		if (typeof t === 'string') return { ja: t, en: '' };
		return { ja: (t?.ja ?? '').trim(), en: (t?.en ?? '').trim() };
	};
	for (const pl of permalinks) {
		for (const kind of ['published_papers', 'books_etc', 'misc']) {
			let data: any;
			try {
				data = await jget(`https://api.researchmap.jp/${encodeURIComponent(pl)}/${kind}?limit=200`);
			} catch {
				continue;
			}
			for (const it of data.items ?? []) {
				const { ja: titleJa, en: titleEn } = titleOf(it);
				const title = (titleJa || titleEn).replace(/^[『「]|[』」]$/g, '').trim();
				if (!title) continue;
				// Ainu scope. These are all verified Ainu researchers, so also accept
				// works titled 北方言語/北海道周辺言語/蝦夷 (Ainu-inclusive typology that
				// omits the word アイヌ — e.g. 「北海道周辺言語における他動性交替」).
				if (!/アイヌ|ainu|樺太|sakhalin|カラフト|蝦夷|aino|北方(諸)?言語|北方のことば|北海道周辺言語|北の言語/i.test(`${titleJa} ${titleEn}`))
					continue;
				const rawDoi = it.identifiers?.doi;
				const doi = (Array.isArray(rawDoi) ? rawDoi[0] : rawDoi) || null;
				const cleanDoi = doi ? String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') : null;
				const key = cleanDoi || `${pl}:${it['rm:id'] ?? title}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const auth = it.authors?.ja ?? it.authors?.en ?? [];
				const venueObj = it.publication_name;
				const venue = (typeof venueObj === 'string' ? venueObj : venueObj?.ja || venueObj?.en) || it.publisher || null;
				const yr = it.publication_date ? Number(String(it.publication_date).slice(0, 4)) : null;
				out.push({
					source: 'researchmap',
					externalId: cleanDoi || key,
					doi: cleanDoi,
					title,
					year: Number.isFinite(yr) ? yr : null,
					type: kind === 'books_etc' ? 'book' : 'article',
					rawType: kind,
					language: 'jpn',
					authors: (auth as any[]).map((a) => String(a.name ?? '').trim()).filter(Boolean),
					venue: typeof venue === 'string' ? venue : null,
					url: cleanDoi ? `https://doi.org/${cleanDoi}` : (it.see_also?.[0]?.['@id'] ?? null),
					pdf: null
				});
			}
		}
		console.log(`  researchmap ${pl}: total ${out.length}`);
	}
	return out;
}

// --- Internet Archive — digitized historical Ainu-language books -------------
// Foundational primary sources with full text: Batchelor's dictionary (1905),
// Chamberlain (1887), Krusenstern's vocabularies (1813), Kindaichi… The full-text
// link grafts onto an existing catalogue record when we already hold the book.
export async function collectInternetArchive(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	const queries = [
		'subject:"Ainu language"',
		'(title:(Ainu) OR title:(Aino) OR title:(Aïno)) AND (title:(grammar) OR title:(dictionary) OR title:(vocabulary) OR title:(language) OR title:(folk-tales) OR title:(folklore) OR title:(conversation) OR title:(grammatik) OR title:(wörter))',
		'(Aino OR Ainu) AND (vocabulary OR grammar OR dictionary OR "folk-tales" OR conversation)'
	];
	for (const q of queries) {
		const url =
			`https://archive.org/advancedsearch.php?q=${encodeURIComponent('(' + q + ') AND mediatype:texts')}` +
			`&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=year&fl[]=date&fl[]=subject&rows=120&output=json`;
		let data: any;
		try {
			data = await jget(url);
		} catch {
			continue;
		}
		for (const d of data.response?.docs ?? []) {
			const id = String(d.identifier ?? '');
			const title = String(d.title ?? '').trim();
			if (!id || !title || seen.has(id)) continue;
			if (/^(enwiki|jawiki|wikipedia|wikimedia)/i.test(id)) continue; // drop wiki dumps
			const subj = Array.isArray(d.subject) ? d.subject.join(' ') : String(d.subject ?? '');
			// Require Ainu in the TITLE, or a primary "Ainu language" subject (keeps
			// subject-only classics like Krusenstern's Wörter-Sammlungen).
			const titleHasAinu =
				/ainu|aïno/i.test(title) || (/\baino\b/i.test(title) && /vocab|grammar|dictionar|language|folk|tales|conversation|wörter|grammatik/i.test(title));
			const subjectIsAinu = /ainu language|アイヌ語/i.test(subj);
			if (!titleHasAinu && !subjectIsAinu) continue;
			// Hard drops for cross-language false positives that slip through metadata.
			if (/indo-european|chamorro|chamoro|magyar|fiatal kutató|únkp|tagalog|chamoru/i.test(title)) continue;
			seen.add(id);
			const yr = d.year ?? (d.date ? String(d.date).slice(0, 4) : null);
			const year = yr ? Number(yr) : null;
			out.push({
				source: 'internetarchive',
				externalId: id,
				doi: null,
				title,
				year: Number.isFinite(year) ? year : null,
				type: 'book',
				rawType: 'book',
				language: null,
				authors: d.creator ? (Array.isArray(d.creator) ? d.creator : [d.creator]).map(String) : [],
				venue: null,
				url: `https://archive.org/details/${id}`,
				pdf: null,
				links: [{ type: 'fulltext', url: `https://archive.org/details/${id}`, label: 'Internet Archive (full text)' }]
			});
		}
		console.log(`  Internet Archive "${q.slice(0, 30)}…": total ${out.length}`);
	}
	return out;
}

// --- NDL Digital Collections — digitized texts with IIIF --------------------
// The ndlsearch OpenSearch RSS flags a digitized item with an <rdfs:seeAlso>
// pointing at dl.ndl.go.jp/pid/N. We keep Ainu-language digitized items and
// attach the NDL full-text page + IIIF manifest (public-domain items render).
// Links graft onto an existing catalogue record (アイヌ神謡集…) when we hold it.
const NDL_DIGITAL_QUERIES = [
	'アイヌ語', 'アイヌ 辞典', 'アイヌ 文法', 'アイヌ 地名', 'アイヌ 神謡', 'アイヌ ユーカラ',
	'アイヌ 物語', 'アイヌ 会話', 'アイヌ 童話', '蝦夷 言葉', 'アイヌ 語彙'
];
const NDL_LING_RE = /語彙?|辞典|辞書|文法|方言|地名|音声|会話|叙事詩|口承|ユーカラ|ユカ|神謡|説話|語学|言語|文字|物語|童話|歌|聖書|新約|入門|読本/;
export async function collectNDLDigital(): Promise<AcademicRecord[]> {
	const out: AcademicRecord[] = [];
	const seen = new Set<string>();
	for (const q of NDL_DIGITAL_QUERIES) {
		let xml: string;
		try {
			xml = await htext(`https://ndlsearch.ndl.go.jp/api/opensearch?any=${encodeURIComponent(q)}&cnt=200`);
		} catch {
			continue;
		}
		for (const it of xml.split('<item>').slice(1)) {
			const pidM = it.match(/dl\.ndl\.go\.jp\/pid\/(\d+)/);
			if (!pidM) continue; // only digitized items carry a pid seeAlso
			const pid = pidM[1];
			if (seen.has(pid)) continue;
			const title = cleanText(xmlFirst(it, 'title'));
			if (!title || !/アイヌ|蝦夷|あいぬ/.test(title) || !NDL_LING_RE.test(title)) continue;
			seen.add(pid);
			const yr = (cleanText(xmlFirst(it, 'dc:date')) || cleanText(xmlFirst(it, 'dcterms:issued'))).match(/\d{4}/);
			const creators = [...it.matchAll(/<dc:creator>([\s\S]*?)<\/dc:creator>/g)]
				.map((m) => cleanText(m[1]).replace(/\s*,?\s*\d{4}-\d{0,4}\s*$/, '').trim())
				.filter(Boolean);
			out.push({
				source: 'ndldigital',
				externalId: pid,
				doi: null,
				title,
				year: yr ? Number(yr[0]) : null,
				type: 'book',
				rawType: 'book',
				language: null,
				authors: [...new Set(creators)].slice(0, 4),
				venue: null,
				url: `https://dl.ndl.go.jp/pid/${pid}`,
				pdf: null,
				links: [
					{ type: 'iiif', url: `https://dl.ndl.go.jp/api/iiif/${pid}/manifest.json`, label: 'IIIF (NDL Digital)' },
					{ type: 'fulltext', url: `https://dl.ndl.go.jp/pid/${pid}`, label: 'NDL Digital Collections' }
				]
			});
		}
		console.log(`  NDL Digital "${q}": total ${out.length}`);
	}
	return out;
}

// Run only the new collectors and merge them into the existing index (the full
// main() run is slow/flaky). `bun collect-academic.ts extra`.
export async function collectExtra(): Promise<void> {
	if (!fs.existsSync(OUT_FILE)) throw new Error('academic-index.json missing — run a full collect first');
	const existing: AcademicRecord[] = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
	console.log(`Existing index: ${existing.length} records`);

	console.log('Collecting J-STAGE…');
	const jstage = await collectJStage();
	console.log('Collecting CiNii Books…');
	const ciniiBooks = await collectCiNiiBooks();
	console.log('Collecting IRDB…');
	const irdb = await collectIRDB();
	console.log('Collecting Crossref chapters…');
	const crChap = await collectCrossrefChapters();
	console.log('Collecting Glottolog…');
	const glotto = await collectGlottolog();
	console.log('Collecting OpenAlex extra…');
	const oaExtra = await collectOpenAlexExtra();
	console.log('Collecting researchmap (individual researchers)…');
	const rmap = await collectResearchmap(RESEARCHMAP_PERMALINKS);
	console.log('Collecting Internet Archive (digitized historical books)…');
	const ia = await collectInternetArchive();
	console.log('Collecting NDL Digital Collections (IIIF)…');
	const ndldig = await collectNDLDigital();

	// Dedup against the existing index (DOI + normalized title) and each other.
	const seenDoi = new Set<string>();
	const seenTitle = new Set<string>();
	for (const r of existing) {
		const d = r.doi?.toLowerCase();
		if (d) seenDoi.add(d);
		const t = normTitle(r.title);
		if (t) seenTitle.add(t);
	}
	const fresh: AcademicRecord[] = [];
	const perSource: Record<string, number> = {};
	for (const r of [...jstage, ...ciniiBooks, ...irdb, ...crChap, ...glotto, ...oaExtra, ...rmap, ...ia, ...ndldig]) {
		// Link-bearing records (IA full text, IIIF…) are KEPT even on a title match —
		// seedAcademic grafts their links onto the existing record rather than drop.
		if (r.links?.length || r.pdf) {
			fresh.push(r);
			perSource[r.source] = (perSource[r.source] ?? 0) + 1;
			continue;
		}
		const d = r.doi?.toLowerCase() ?? null;
		const t = normTitle(r.title);
		if ((d && seenDoi.has(d)) || (t && seenTitle.has(t))) continue;
		if (d) seenDoi.add(d);
		if (t) seenTitle.add(t);
		fresh.push(r);
		perSource[r.source] = (perSource[r.source] ?? 0) + 1;
	}

	// Enrich kept CiNii Books with publication year (survivors only).
	await enrichCiNiiBooks(fresh.filter((r) => r.source === 'cinii-books'));

	const merged = [...existing, ...fresh];
	fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2));
	console.log(`\nAdded ${fresh.length} new records (by source: ${JSON.stringify(perSource)})`);
	console.log(`Index: ${existing.length} → ${merged.length}`);
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
	console.log('Collecting Honkoku transcription project (みんなで翻刻)…');
	const honkoku = await collectHonkoku();
	console.log('Collecting NIJL Kokusho IIIF (蝦夷 materials)…');
	const kokusho = await collectKokusho();
	console.log('Collecting Hugging Face (Ainu models)…');
	const huggingface = await collectHuggingFace();
	console.log('Collecting Qiita (アイヌ語 articles)…');
	const qiita = await collectQiita();

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
		...sgu,
		...honkoku,
		...kokusho,
		...huggingface,
		...qiita
	].filter((r) => r.title && r.title.length > 2);
	const seenDoi = new Set<string>();
	const seenTitle = new Set<string>();
	const merged: AcademicRecord[] = [];
	for (const r of all) {
		// Link-bearing records (Honkoku transcriptions, Kokusho IIIF) are kept as
		// individual witnesses — seedAcademic dedups/grafts their links onto the
		// matching original book, so we must NOT collapse them here by title.
		if (r.links?.length) {
			merged.push(r);
			continue;
		}
		const d = r.doi?.toLowerCase() ?? null;
		const t = normTitle(r.title);
		if ((d && seenDoi.has(d)) || (t && seenTitle.has(t))) continue;
		if (d) seenDoi.add(d);
		if (t) seenTitle.add(t);
		merged.push(r);
	}

	fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 2));
	console.log('Building internal citation graph (cites relations)…');
	await writeCitationEdges().catch((e) => console.warn('  ! citation edges failed:', e?.message ?? e));
	const bySource = merged.reduce<Record<string, number>>((m, r) => ((m[r.source] = (m[r.source] ?? 0) + 1), m), {});
	const withDoi = merged.filter((r) => r.doi).length;
	console.log(`\nWrote ${merged.length} records → ${path.relative(process.cwd(), OUT_FILE)}`);
	console.log(`  by source: ${JSON.stringify(bySource)} · with DOI: ${withDoi}`);
	console.log(
		`  (raw: openalex ${openalex.length}, native ${openalexNative.length}, chained ${openalexChained.length}, forward ${openalexForward.length}, crossref ${crossref.length}, cinii ${cinii.length}, togo ${togo.length}, hoppodb ${hoppodb.length}, sgu ${sgu.length}, honkoku ${honkoku.length}, kokusho ${kokusho.length}, hf ${huggingface.length}, qiita ${qiita.length})`
	);
}

if (import.meta.main) {
	// `bun collect-academic.ts edges` refreshes only the citation graph; `… extra`
	// runs only the new collectors and merges them in; no args runs everything.
	const task = process.argv.includes('edges')
		? writeCitationEdges()
		: process.argv.includes('extra')
			? collectExtra()
			: main();
	task.catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
