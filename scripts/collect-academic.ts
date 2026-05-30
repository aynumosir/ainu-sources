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
	source: string; // 'openalex' | 'crossref' | 'cinii' | ...
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
}

async function jget(url: string): Promise<any> {
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
	if (!res.ok) throw new Error(`${res.status} ${url}`);
	return res.json();
}

function normType(t: string): string {
	return /book|monograph|dissertation|thesis/i.test(t) ? 'grammar-book' : 'grammar-article';
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
		for (const w of data.results ?? []) {
			const doi = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : null;
			const loc = w.primary_location ?? w.best_oa_location ?? null;
			const oa = w.best_oa_location ?? null;
			out.push({
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
			});
		}
		cursor = data.meta?.next_cursor ?? null;
		page += 1;
		console.log(`  OpenAlex page ${page}: +${data.results?.length ?? 0} (total ${out.length})`);
		if (!data.results?.length) break;
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
		.replace(/[^a-z0-9぀-ヿ一-龯Ѐ-ӿ]+/g, '');
}

async function main() {
	if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
	console.log('Collecting OpenAlex (Ainu × Linguistics)…');
	const openalex = await collectOpenAlex();
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

	// Merge with cross-source dedup: DOI-bearing records first (OpenAlex,
	// Crossref), then articles (CiNii), then books (Open Library, NDL). Same
	// title across sources collapses to the first (richest) record.
	const all = [...openalex, ...crossref, ...cinii, ...openlibrary, ...ndl, ...cyberleninka].filter(
		(r) => r.title && r.title.length > 2
	);
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
	console.log(`  (raw: openalex ${openalex.length}, crossref ${crossref.length}, cinii ${cinii.length})`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
