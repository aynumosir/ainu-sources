// ---------------------------------------------------------------------------
// Citation network analysis — builds the source-to-source `cites` graph and
// scores each work's significance with PageRank (the same eigenvector-centrality
// algorithm Google uses), plus citation in-degree. Powers the /network 3D graph.
// ---------------------------------------------------------------------------
import { db } from './db';
import { sources, sourceRelations, sourcePersons, persons } from './db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { activeSourcesOnly, publicRelationsOnly } from './visibility';

export interface NetworkNode {
	id: string;
	slug: string;
	title: string;
	titleEn: string | null;
	year: number | null;
	type: string;
	category: string;
	author: string | null;
	significance: number; // PageRank, 0..1 (normalized so max = 1)
	inDegree: number; // times cited within the graph
	outDegree: number; // works it cites within the graph
}
export interface NetworkLink {
	source: string;
	target: string;
}
export interface NetworkData {
	nodes: NetworkNode[];
	links: NetworkLink[];
	stats: { nodes: number; edges: number; topId: string | null };
}

/** Power-iteration PageRank over an adjacency list. Handles dangling nodes. */
function pageRank(ids: string[], out: Map<string, string[]>, d = 0.85, iters = 60): Map<string, number> {
	const N = ids.length;
	if (!N) return new Map();
	let pr = new Map(ids.map((i) => [i, 1 / N]));
	for (let it = 0; it < iters; it++) {
		const np = new Map(ids.map((i) => [i, (1 - d) / N]));
		let dangling = 0;
		for (const i of ids) if (!(out.get(i)?.length)) dangling += pr.get(i)!;
		for (const i of ids) {
			const o = out.get(i);
			if (o?.length) {
				const share = (d * pr.get(i)!) / o.length;
				for (const t of o) np.set(t, np.get(t)! + share);
			}
		}
		const dangShare = (d * dangling) / N;
		for (const i of ids) np.set(i, np.get(i)! + dangShare);
		pr = np;
	}
	return pr;
}

/**
 * PageRank over every active source, scored on the accepted 'cites' edges.
 * Sources that touch no edge stay in the node set as dangling nodes and
 * receive the uniform floor, so isolated works still sort below cited ones.
 * Scores are normalized so the top work is exactly 1.
 */
export async function computeSourceSignificance(): Promise<Map<string, number>> {
	const [rows, rawEdges] = await Promise.all([
		db.select({ id: sources.id }).from(sources).where(activeSourcesOnly()),
		db
			.select({ f: sourceRelations.fromSourceId, t: sourceRelations.toSourceId })
			.from(sourceRelations)
			.where(and(eq(sourceRelations.type, 'cites'), publicRelationsOnly()))
	]);
	const activeIds = new Set(rows.map((r) => r.id));
	const ids = [...activeIds];
	if (!ids.length) return new Map();
	const out = new Map<string, string[]>();
	for (const e of rawEdges) {
		if (!activeIds.has(e.f) || !activeIds.has(e.t)) continue;
		(out.get(e.f) ?? out.set(e.f, []).get(e.f)!).push(e.t);
	}
	const pr = pageRank(ids, out);
	const maxPr = Math.max(...ids.map((i) => pr.get(i) ?? 0), 1e-9);
	return new Map(ids.map((i) => [i, (pr.get(i) ?? 0) / maxPr]));
}

export async function getCitationNetwork(): Promise<NetworkData> {
	// Public graph = ACCEPTED 'cites' edges only (candidate/rejected/removed edges
	// are invisible). No-op while every relation is 'accepted'.
	const rawEdges = await db
		.select({ f: sourceRelations.fromSourceId, t: sourceRelations.toSourceId })
		.from(sourceRelations)
		.where(and(eq(sourceRelations.type, 'cites'), publicRelationsOnly()));

	const candidateIds = new Set<string>();
	for (const e of rawEdges) {
		candidateIds.add(e.f);
		candidateIds.add(e.t);
	}
	if (!candidateIds.size) return { nodes: [], links: [], stats: { nodes: 0, edges: 0, topId: null } };

	// Resolve which endpoints are publicly-visible (active) sources, then drop any
	// edge that touches a non-active (or vanished) source so a hidden/merged work
	// never appears as a node — nor as a phantom node referenced by a dangling link.
	const rows = await db
		.select({
			id: sources.id,
			slug: sources.slug,
			title: sources.title,
			titleEn: sources.titleEn,
			year: sources.yearStart,
			type: sources.type,
			category: sources.category,
			author: sources.author
		})
		.from(sources)
		.where(and(inArray(sources.id, [...candidateIds]), activeSourcesOnly()));
	const activeIds = new Set(rows.map((r) => r.id));

	const edges = rawEdges.filter((e) => activeIds.has(e.f) && activeIds.has(e.t));
	const ids = new Set<string>();
	for (const e of edges) {
		ids.add(e.f);
		ids.add(e.t);
	}
	if (!ids.size) return { nodes: [], links: [], stats: { nodes: 0, edges: 0, topId: null } };

	const out = new Map<string, string[]>();
	const inDeg = new Map<string, number>();
	const outDeg = new Map<string, number>();
	for (const e of edges) {
		(out.get(e.f) ?? out.set(e.f, []).get(e.f)!).push(e.t);
		inDeg.set(e.t, (inDeg.get(e.t) ?? 0) + 1);
		outDeg.set(e.f, (outDeg.get(e.f) ?? 0) + 1);
	}

	const idList = [...ids];
	const pr = pageRank(idList, out);
	const maxPr = Math.max(...idList.map((i) => pr.get(i) ?? 0), 1e-9);

	// Prefer the CURATED author/editor links (sourcePersons) over the free-form
	// `sources.author` string, which carries OpenAlex/Crossref noise — e.g. book
	// reviews whose reviewer gets merged in as a co-author (John C. Street was the
	// reviewer of Refsing's Shizunai grammar, not its author). Fall back to the
	// free-form string only when a work has no normalized author links.
	const personRows = await db
		.select({
			sourceId: sourcePersons.sourceId,
			name: persons.name,
			nameEn: persons.nameEn,
			role: sourcePersons.role,
			sortOrder: sourcePersons.sortOrder
		})
		.from(sourcePersons)
		.innerJoin(persons, eq(persons.id, sourcePersons.personId))
		.where(
			and(
				inArray(sourcePersons.sourceId, idList),
				inArray(sourcePersons.role, ['author', 'editor'])
			)
		);
	const authorsBySource = new Map<string, { name: string; sortOrder: number }[]>();
	for (const p of personRows) {
		const list = authorsBySource.get(p.sourceId) ?? [];
		list.push({ name: p.name ?? p.nameEn ?? '', sortOrder: p.sortOrder });
		authorsBySource.set(p.sourceId, list);
	}
	const curatedAuthor = (id: string, freeform: string | null): string | null => {
		const list = authorsBySource.get(id);
		if (!list?.length) return freeform;
		return list
			.sort((a, b) => a.sortOrder - b.sortOrder)
			.map((x) => x.name)
			.filter(Boolean)
			.join('、');
	};

	// `rows` is every active candidate endpoint; keep only those still present in a
	// surviving edge (an active source whose every cites edge pointed at a hidden
	// partner drops out of the graph entirely).
	const visibleRows = rows.filter((r) => ids.has(r.id));
	let topId: string | null = null;
	let topPr = -1;
	const nodes: NetworkNode[] = visibleRows.map((r) => {
		const p = pr.get(r.id) ?? 0;
		if (p > topPr) {
			topPr = p;
			topId = r.id;
		}
		return {
			id: r.id,
			slug: r.slug,
			title: r.title,
			titleEn: r.titleEn,
			year: r.year,
			type: r.type,
			category: r.category,
			author: curatedAuthor(r.id, r.author),
			significance: p / maxPr, // normalized 0..1
			inDegree: inDeg.get(r.id) ?? 0,
			outDegree: outDeg.get(r.id) ?? 0
		};
	});
	nodes.sort((a, b) => b.significance - a.significance);

	return {
		nodes,
		links: edges.map((e) => ({ source: e.f, target: e.t })),
		stats: { nodes: nodes.length, edges: edges.length, topId }
	};
}
