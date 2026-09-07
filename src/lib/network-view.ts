import type { NetworkData, NetworkNode } from './server/network';

/** Keep ties equal and retain the full-network scale when changing the view. */
export function significanceHeat(nodes: NetworkNode[]): Map<string, number> {
	const values = [...new Set(nodes.map((node) => node.significance))].sort((a, b) => a - b);
	const ranks = new Map(
		values.map((value, i) => [value, values.length > 1 ? i / (values.length - 1) : 0.5])
	);
	return new Map(nodes.map((node) => [node.id, ranks.get(node.significance)!]));
}

export function rankedNodes(nodes: NetworkNode[]): NetworkNode[] {
	return [...nodes].sort((a, b) => b.significance - a.significance || a.id.localeCompare(b.id));
}

/** Focus includes every direct citation, even when the overview is capped. */
export function networkView(network: NetworkData, limit: number, selectedId: string | null) {
	const ranked = rankedNodes(network.nodes);
	const ids = new Set<string>();
	const focusId = ranked.some((node) => node.id === selectedId) ? selectedId : null;
	if (focusId) {
		ids.add(focusId);
		for (const link of network.links) {
			if (link.source === focusId) ids.add(link.target);
			if (link.target === focusId) ids.add(link.source);
		}
	} else {
		for (const node of limit > 0 ? ranked.slice(0, limit) : ranked) ids.add(node.id);
	}
	const nodes = ranked.filter((node) => ids.has(node.id));
	const valid = new Set(nodes.map((node) => node.id));
	const links = network.links.filter(
		(link) =>
			valid.has(link.source) &&
			valid.has(link.target) &&
			(!focusId || link.source === focusId || link.target === focusId)
	);
	return { nodes, links };
}

export function searchNodes(nodes: NetworkNode[], query: string): NetworkNode[] {
	const terms = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
	return nodes.filter((node) => {
		const text = [node.title, node.titleEn, node.author, node.year]
			.filter(Boolean)
			.join(' ')
			.normalize('NFKC')
			.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
