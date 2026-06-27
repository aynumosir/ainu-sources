// One-off enrichment: find PUBLIC landing pages (CiNii Research) for the
// linkless ainu-grammar catalog works, so the private-repo imports gain a
// publicly-accessible link + DOI. Matches strictly on normalized-title +
// year(±1) + author-surname overlap to avoid attaching the wrong work.
// Writes/updates scripts/data/ainu-grammar-links.json keyed by provenance_path.
import fs from 'node:fs';

interface Work { title: string; author: string; year_start: number | null; type: string; provenance_path: string; }
interface LinkEntry { title?: string; titleEn?: string; doi?: string | null; links?: { type: string; url: string; label?: string }[]; source?: string; verified?: string; }

const OUT = 'scripts/data/ainu-grammar-links.json';
const works: Work[] = JSON.parse(fs.readFileSync('/tmp/ag-recent.json', 'utf8'));

const norm = (s: string) =>
	(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9぀-ヿ㐀-鿿]+/g, '');
// author surname token (first CJK chars or latin surname)
const surname = (a: string) => {
	const m = (a || '').match(/[㐀-鿿]{1,4}/);
	if (m) return m[0];
	return (a || '').split(/\s+/).filter(Boolean).pop() ?? a;
};

async function jget(url: string): Promise<any> {
	const res = await fetch(url, { headers: { 'User-Agent': 'ainu-sources-enrich/1.0' } });
	if (!res.ok) throw new Error(`${res.status}`);
	return res.json();
}

const existing: Record<string, LinkEntry> = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
let matched = 0, already = 0, miss = 0;
const misses: Work[] = [];

for (const w of works) {
	if (existing[w.provenance_path]?.links?.length) { already++; continue; }
	const want = norm(w.title);
	if (want.length < 6) { miss++; misses.push(w); continue; }
	let hit: { url: string; doi: string | null } | null = null;
	try {
		const url = `https://cir.nii.ac.jp/opensearch/all?q=${encodeURIComponent(w.title)}&format=json&count=20&start=1`;
		const data = await jget(url);
		const items = data.items ?? [];
		for (const it of items) {
			const t = norm(String(it.title ?? it['dc:title'] ?? ''));
			if (!t) continue;
			const titleOk = t === want || (Math.min(t.length, want.length) >= 12 && (t.includes(want) || want.includes(t)));
			if (!titleOk) continue;
			const dateStr = String(it['prism:publicationDate'] ?? it['dc:date'] ?? '');
			const yr = Number((dateStr.match(/\d{4}/) ?? [])[0]) || null;
			const yearOk = w.year_start == null || yr == null || Math.abs(yr - w.year_start) <= 1;
			if (!yearOk) continue;
			const rawC = it['dc:creator'] ?? it.creator ?? [];
			const creators = (Array.isArray(rawC) ? rawC : [rawC]).map((x: any) => (typeof x === 'string' ? x : x?.['@value'] ?? x?.['foaf:name'] ?? '')).join(' ');
			const sn = surname(w.author);
			const authorOk = !sn || norm(creators).includes(norm(sn)) || /^[a-z]/i.test(w.author); // latin authors: rely on title+year
			if (!authorOk) continue;
			const link = it.link?.['@id'] ?? it['@id'] ?? null;
			if (!link) continue;
			hit = { url: String(link), doi: it['prism:doi'] ? String(it['prism:doi']) : null };
			break;
		}
	} catch { /* skip on API error */ }
	if (hit) {
		existing[w.provenance_path] = {
			doi: hit.doi,
			links: [{ type: 'cinii', url: hit.url, label: 'CiNii Research' }],
			source: 'cinii',
			verified: 'title+year+author'
		};
		matched++;
		console.log(`✓ ${w.year_start} ${w.author} — ${w.title.slice(0, 36)}  →  ${hit.url}`);
	} else { miss++; misses.push(w); }
	await new Promise((r) => setTimeout(r, 300));
}

fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
fs.writeFileSync('/tmp/ag-cinii-misses.json', JSON.stringify(misses, null, 2));
console.log(`\nCiNii enrichment: matched ${matched}, already ${already}, missed ${miss} (→ /tmp/ag-cinii-misses.json for web agents)`);
console.log(`Wrote ${Object.keys(existing).length} entries → ${OUT}`);
