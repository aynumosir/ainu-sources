// ---------------------------------------------------------------------------
// Citation network analysis — builds the source-to-source `cites` graph and
// scores each work's significance with PageRank (the same eigenvector-centrality
// algorithm Google uses), plus citation in-degree. Powers the /network 3D graph.
// ---------------------------------------------------------------------------
import { db } from './db';
import { sources, sourceRelations } from './db/schema';
import { and, eq, inArray } from 'drizzle-orm';

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

export async function getCitationNetwork(): Promise<NetworkData> {
	const edges = await db
		.select({ f: sourceRelations.fromSourceId, t: sourceRelations.toSourceId })
		.from(sourceRelations)
		.where(eq(sourceRelations.type, 'cites'));

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
		.where(inArray(sources.id, idList));

	let topId: string | null = null;
	let topPr = -1;
	const nodes: NetworkNode[] = rows.map((r) => {
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
			author: r.author,
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
