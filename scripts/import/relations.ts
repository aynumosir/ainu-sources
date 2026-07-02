#!/usr/bin/env bun
/**
 * Feed #7 — RELATIONS post-pass importer (idempotent). Runs AFTER every source
 * importer: it reads no upstream catalogue of its own, it derives source→source
 * edges FROM the sources that already exist and upserts them into `source_relations`.
 *
 * The merge-engine-era replacement for seed.ts's `buildSameWorkRelations` + the
 * `seedAcademic` citation-graph tail. It reproduces BOTH, VERBATIM:
 *
 *   1. Same-work clustering (seed.ts `buildSameWorkRelations`): group every source
 *      by `coreKey(title)` (volume/part/holding-suffix-stripped, derive.ts) and, for
 *      each ≥2-distinct-title, ≤30-member cluster, classify every title pair:
 *        • substring + DIFFERENT year + neither carries a part marker → `edition-of`
 *          (newer → older; oldest = the original work),
 *        • substring + SAME year + neither part-marked → `duplicate-of`
 *          (notes='author-confirmed' when the two authors loosely agree),
 *        • otherwise → `same-work` (a genuine multi-part serial: 藻汐草 乾/坤,
 *          アイヌ語会話篇 一–五, the 19-installment Dobrotvorsky translation…).
 *      The PART_MARKER_RE / hasPartMarker / authAgree guards are reproduced exactly —
 *      without the part-marker guard the substring rule matches every installment
 *      against its bare base title and inflates editions ~14→53 false pairs.
 *
 *   2. Citation edges (seed.ts `seedAcademic` tail): read scripts/data/citation-edges.json
 *      (OpenAlex-attested A→B citations, ~228), map each endpoint's OpenAlex work id to
 *      a source via its `openalex_work` identifier, drop self-loops and chronologically
 *      impossible edges (a work cannot cite one published >1yr later), de-duplicate, and
 *      record each survivor as a `cites` relation.
 *
 * Status : 'accepted' — seed inserted every relation with the schema default
 *          (source_relations.status DEFAULT 'accepted'), and the golden projection
 *          captures accepted edges; the public site's publicRelationsOnly() renders
 *          exactly this status. Matching it keeps the golden projection stable.
 * Origin : 'relations' — a run + provenance stamp; observationId stays null (a relation
 *          is derived from the whole catalogue, not a single source observation).
 *
 * Idempotency (the golden-projection gate): every candidate edge is existence-checked
 * on (from, to, type) before insert — never a delete, never a wipe, no transaction.
 *   • `cites` / `edition-of` carry a DETERMINISTIC direction (the citation datum /
 *     the year comparison), so an EXACT (from,to,type) check re-attaches to the
 *     bootstrapped row and adds nothing.
 *   • `same-work` / `duplicate-of` carry a direction that in seed depended on source
 *     LOAD ORDER (a=cluster[i], b=cluster[j], i<j) — not reproducible from the DB — so
 *     they are checked BIDIRECTIONALLY: an edge whose reverse already exists is a noop.
 *     New clusters are paired in a deterministic id order so run1 and run2 agree.
 * A 2nd identical run therefore inserts ZERO rows (rootHash unchanged), and the first
 * run over a pristine bootstrap re-attaches the existing edges and only adds relations
 * for sources added since the last seed (approved-additive; nothing is ever removed).
 *
 * Flags: --db file:/path (or DATABASE_URL) [--token T] [--dry-run].
 *
 * Run:  DATABASE_URL=file:/tmp/clone.db bun run import:relations
 *       DATABASE_URL=file:/tmp/clone.db bun run import:relations --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, or } from 'drizzle-orm';
import { coreKey, normTitle } from './lib/derive';
import {
	openRun,
	closeRun,
	parseImporterCli,
	type ImporterRunOptions,
	type ImporterSummary
} from './lib/run';
import { sources, sourceIdentifiers, sourceRelations } from '../../src/lib/server/db/schema';
import { normalizeIdentifier } from '../../src/lib/server/merge';
import { ACTIVE_SOURCE_STATUS, PUBLIC_RELATION_STATUS } from '../../src/lib/server/visibility';
import type { Db } from './lib/entities';

// citation-edges.json lives beside seed.ts (scripts/data), NOT under $AINU_ROOT.
const CITATION_EDGES_FILE = path.join(import.meta.dir, '..', 'data', 'citation-edges.json');

const ORIGIN = 'relations';
const uuid = () => crypto.randomUUID();

// seed.ts §buildSameWorkRelations, VERBATIM — a title carries a part/continuation
// marker (多巻 serial installment); used to tell genuine same-work serials apart
// from editions/duplicates of one title.
const PART_MARKER_RE =
	/[(（]\s*[0-9０-９]+\s*[)）]|その\s*[0-9０-９一二三四五六七八九十]+|第\s*[0-9０-９一二三四五六七八九十]+\s*[回報編]|\bpart\s*[0-9]+|[(（]\s*[上中下一二三四五六七八九十]\s*[)）]|續|続|績|承前|つづき|補遺|遺稿|續稿|続稿|後篇|前篇|前編|後編|上巻|下巻|乾|坤/;
const hasPartMarker = (t: string) => PART_MARKER_RE.test(t);
// Loose author agreement (romanization/delimiter/variant-tolerant) — only used to
// flag the safest duplicates, never as a gate (it false-negatives on romaji variants).
function authAgree(a: string, b: string): boolean {
	const norm = (s: string) => (s || '').normalize('NFKC').replace(/[\s　,;，；・]+/g, '').toLowerCase();
	const x = norm(a),
		y = norm(b);
	return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

/** A source row as far as relation derivation cares. */
interface SourceLite {
	id: string;
	title: string;
	yearStart: number | null;
	author: string | null;
}
/** One derived edge awaiting an existence-checked upsert. */
interface Edge {
	fromSourceId: string;
	toSourceId: string;
	/** same-work | edition-of | duplicate-of | cites */
	type: string;
	notes: string | null;
	/** symmetric direction (seed load-order dependent) ⇒ check both (from,to) and (to,from). */
	bidirectional: boolean;
}

/**
 * seed.ts `buildSameWorkRelations`, reproduced VERBATIM over the DB's ACTIVE sources
 * (= seed's `sourceRows`). Sources are iterated in a fixed id order so a new cluster's
 * pairing is deterministic across runs; the classification (edition/duplicate/same)
 * depends only on title/year/author, never on order, so it matches the bootstrap.
 */
function buildSameWorkEdges(rows: SourceLite[]): Edge[] {
	const byCore = new Map<string, SourceLite[]>();
	for (const s of rows) {
		const k = coreKey(s.title);
		if (k.length < 5) continue;
		if (!byCore.has(k)) byCore.set(k, []);
		byCore.get(k)!.push(s);
	}
	const edges: Edge[] = [];
	let same = 0,
		editions = 0,
		dups = 0;
	for (const cluster of byCore.values()) {
		if (cluster.length < 2) continue;
		if (new Set(cluster.map((s) => s.title)).size < 2) continue; // identical titles ⇒ not a part series
		if (cluster.length > 30) continue; // pathological (a too-generic core title) — skip
		for (let i = 0; i < cluster.length; i++)
			for (let j = i + 1; j < cluster.length; j++) {
				const a = cluster[i],
					b = cluster[j];
				const ta = a.title,
					tb = b.title;
				const na = normTitle(ta),
					nb = normTitle(tb);
				const substr = na.includes(nb) || nb.includes(na);
				const ya = a.yearStart,
					yb = b.yearStart;
				if (!hasPartMarker(ta) && !hasPartMarker(tb) && substr && ya != null && yb != null && ya !== yb) {
					const [from, to] = ya > yb ? [a, b] : [b, a]; // newer cites older; oldest = original
					edges.push({ fromSourceId: from.id, toSourceId: to.id, type: 'edition-of', notes: null, bidirectional: false });
					editions++;
				} else if (!hasPartMarker(ta) && !hasPartMarker(tb) && substr && ya != null && yb != null && ya === yb) {
					const note = authAgree(a.author ?? '', b.author ?? '') ? 'author-confirmed' : null;
					edges.push({ fromSourceId: a.id, toSourceId: b.id, type: 'duplicate-of', notes: note, bidirectional: true });
					dups++;
				} else {
					edges.push({ fromSourceId: a.id, toSourceId: b.id, type: 'same-work', notes: null, bidirectional: true });
					same++;
				}
			}
	}
	console.log(`  coreKey clusters: same-work ${same}, edition-of ${editions}, duplicate-of ${dups}`);
	return edges;
}

/**
 * seed.ts `seedAcademic` citation tail, reproduced VERBATIM. Each edge's OpenAlex work
 * id resolves to a source via its `openalex_work` identifier (the same id the bootstrap
 * wrote for openalex records); self-loops and chronologically impossible edges are
 * dropped and (from,to) pairs de-duplicated, exactly as seed did.
 */
function buildCitationEdges(oaToSource: Map<string, string>, yearById: Map<string, number | null>): Edge[] {
	if (!fs.existsSync(CITATION_EDGES_FILE)) {
		console.warn(`  ! citation edges not found at ${CITATION_EDGES_FILE} — skipping cites`);
		return [];
	}
	const raw: { from: string; to: string }[] = JSON.parse(fs.readFileSync(CITATION_EDGES_FILE, 'utf8'));
	const edges: Edge[] = [];
	const seen = new Set<string>();
	let dropped = 0,
		unresolved = 0;
	for (const e of raw) {
		const fromId = oaToSource.get(normalizeIdentifier({ kind: 'openalex_work', value: e.from }).valueNorm);
		const toId = oaToSource.get(normalizeIdentifier({ kind: 'openalex_work', value: e.to }).valueNorm);
		if (!fromId || !toId) {
			unresolved++;
			continue;
		}
		if (fromId === toId) continue; // self-loop (both endpoints merged into one source)
		// Drop chronologically impossible citations: a work cannot cite one published
		// more than a year later (survivors are genuine reversed edges after overrides).
		const fy = yearById.get(fromId);
		const ty = yearById.get(toId);
		if (fy != null && ty != null && fy < ty - 1) {
			dropped++;
			continue;
		}
		const k = `${fromId}\t${toId}`;
		if (seen.has(k)) continue;
		seen.add(k);
		edges.push({ fromSourceId: fromId, toSourceId: toId, type: 'cites', notes: null, bidirectional: false });
	}
	console.log(
		`  citation edges: ${edges.length} cites from ${raw.length} edges (dropped ${dropped} chronologically impossible, ${unresolved} unresolved endpoints)`
	);
	return edges;
}

/**
 * True when the (from,to,type) edge — or, for a symmetric type, its reverse — already
 * exists. Never touches the found row (preserves the bootstrapped status/notes/id and
 * so the golden projection).
 */
async function relationExists(db: Db, e: Edge): Promise<boolean> {
	const forward = and(
		eq(sourceRelations.fromSourceId, e.fromSourceId),
		eq(sourceRelations.toSourceId, e.toSourceId),
		eq(sourceRelations.type, e.type)
	);
	const predicate = e.bidirectional
		? or(
				forward,
				and(
					eq(sourceRelations.fromSourceId, e.toSourceId),
					eq(sourceRelations.toSourceId, e.fromSourceId),
					eq(sourceRelations.type, e.type)
				)
			)
		: forward;
	const [hit] = await db.select({ id: sourceRelations.id }).from(sourceRelations).where(predicate).limit(1);
	return !!hit;
}

export async function run(db: Db, opts: ImporterRunOptions = {}): Promise<ImporterSummary> {
	const DRY_RUN = opts.dryRun ?? false;
	console.log(`${DRY_RUN ? '[DRY-RUN] ' : ''}import:relations`);

	// Endpoints resolve against the sources that already exist (feeds #1–#6 have run,
	// or this is the bootstrap). Cluster over ACTIVE sources only (= seed's sourceRows).
	const rows: SourceLite[] = await db
		.select({ id: sources.id, title: sources.title, yearStart: sources.yearStart, author: sources.author })
		.from(sources)
		.where(eq(sources.status, ACTIVE_SOURCE_STATUS))
		.orderBy(sources.id); // deterministic pairing for new clusters
	const yearById = new Map<string, number | null>(rows.map((s) => [s.id, s.yearStart]));

	// OpenAlex work id → source id, from the `openalex_work` identifiers of active
	// sources (the citation graph's endpoint index; seed's `oaToSource`).
	const activeIds = new Set(rows.map((s) => s.id));
	const oaRows = await db
		.select({ valueNorm: sourceIdentifiers.valueNorm, sourceId: sourceIdentifiers.sourceId })
		.from(sourceIdentifiers)
		.where(eq(sourceIdentifiers.kind, 'openalex_work'));
	const oaToSource = new Map<string, string>();
	for (const r of oaRows) if (activeIds.has(r.sourceId)) oaToSource.set(r.valueNorm, r.sourceId);

	const sameWork = buildSameWorkEdges(rows);
	const cites = buildCitationEdges(oaToSource, yearById);
	// Citation edges first (seed's order), then coreKey clusters — deterministic.
	const candidates = [...cites, ...sameWork];

	const stats: Record<string, { attached: number; added: number }> = {};
	const bump = (type: string, key: 'attached' | 'added') => {
		(stats[type] ??= { attached: 0, added: 0 })[key] += 1;
	};

	if (DRY_RUN) {
		let wouldAdd = 0;
		for (const e of candidates) {
			const exists = await relationExists(db, e);
			bump(e.type, exists ? 'attached' : 'added');
			if (!exists) wouldAdd += 1;
		}
		report(stats, candidates.length, wouldAdd, DRY_RUN);
		return toSummary(stats, candidates.length, wouldAdd);
	}

	const runId = await openRun(db, { origin: ORIGIN, mode: 'full', collectorVersion: 'import-relations@1' });
	const now = new Date();
	let added = 0;
	for (const e of candidates) {
		if (await relationExists(db, e)) {
			bump(e.type, 'attached');
			continue;
		}
		await db.insert(sourceRelations).values({
			id: uuid(),
			fromSourceId: e.fromSourceId,
			toSourceId: e.toSourceId,
			type: e.type,
			notes: e.notes,
			status: PUBLIC_RELATION_STATUS, // 'accepted' — matches seed's schema-default insert
			origin: ORIGIN,
			derivation: e.type === 'cites' ? 'citation-graph' : 'same-work-cluster',
			observationId: null,
			evidence: null,
			confidence: null
		});
		bump(e.type, 'added');
		added += 1;
	}

	await closeRun(db, runId, {
		status: 'completed',
		summary: { candidates: candidates.length, added, byType: stats }
	});
	report(stats, candidates.length, added, false);
	return toSummary(stats, candidates.length, added);
}

/** Fold the per-type attach/add tallies into the normalized orchestrator summary. */
function toSummary(
	stats: Record<string, { attached: number; added: number }>,
	candidates: number,
	added: number
): ImporterSummary {
	const attached = Object.values(stats).reduce((n, v) => n + v.attached, 0);
	return {
		feed: 'relations',
		applied: added,
		noop: attached,
		candidate: 0,
		conflict: 0,
		drifted: 0,
		other: 0,
		detail: { candidates, byType: stats }
	};
}

function report(
	stats: Record<string, { attached: number; added: number }>,
	total: number,
	added: number,
	dryRun: boolean
): void {
	const parts = Object.entries(stats)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([t, v]) => `${t}: +${v.added} added / ${v.attached} attached`);
	console.log(`${dryRun ? '[DRY-RUN] ' : ''}done: ${total} candidate edges → ${added} added`);
	for (const p of parts) console.log(`  ${p}`);
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	run(db, opts)
		.then(() => process.exit(0))
		.catch((err) => {
			console.error('\n✗ import:relations failed:', err);
			process.exit(1);
		});
}
