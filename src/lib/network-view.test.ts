import { describe, expect, it } from 'vitest';
import { networkView, searchNodes, significanceHeat } from './network-view';
import type { NetworkData, NetworkNode } from './server/network';
const node = (id: number, significance = id): NetworkNode => ({
	id: String(id),
	slug: String(id),
	title: `Work ${id}`,
	titleEn: null,
	author: null,
	year: null,
	significance,
	inDegree: 0,
	outDegree: 0,
	type: '',
	category: ''
});
const fixture = (count: number): NetworkData => ({
	nodes: Array.from({ length: count }, (_, i) => node(i)),
	links: Array.from({ length: count - 1 }, (_, i) => ({
		source: String(i),
		target: String(i + 1)
	})),
	stats: { nodes: count, edges: count - 1, topId: String(count - 1) }
});
describe('network exploration', () => {
	it.each([696, 1392, 2088])('bounds the overview at %i works with valid endpoints', (count) => {
		const data = fixture(count);
		const view = networkView(data, 150, null);
		expect(view.nodes).toHaveLength(150);
		expect(view.nodes[0].id).toBe(String(count - 1));
		expect(view.links).toHaveLength(149);
		const ids = new Set(view.nodes.map((n) => n.id));
		expect(view.links.every((l) => ids.has(l.source) && ids.has(l.target))).toBe(true);
		expect(networkView(data, 0, null).nodes).toHaveLength(count);
	});
	it('focuses outside the overview and preserves both directions without unrelated edges', () => {
		const data = fixture(700);
		data.links.push({ source: '1', target: '3' }, { source: '2', target: '1' });
		const view = networkView(data, 150, '2');
		expect(view.nodes.map((n) => n.id).sort()).toEqual(['1', '2', '3']);
		expect(view.links).toEqual([
			{ source: '1', target: '2' },
			{ source: '2', target: '3' },
			{ source: '2', target: '1' }
		]);
		expect(typeof data.links[0].source).toBe('string');
	});
	it('keeps tied significance scores equal', () => {
		const heat = significanceHeat([node(1, 0.1), node(2, 0.1), node(3, 1)]);
		expect(heat.get('1')).toBe(heat.get('2'));
		expect(heat.get('3')).toBe(1);
	});
	it('searches translated titles, author and year with normalized text', () => {
		const n = {
			...node(1),
			title: 'アイヌ語',
			titleEn: 'Ainu Dictionary',
			author: '田村',
			year: 1996
		};
		expect(searchNodes([n], 'ＡＩＮＵ １９９６')).toEqual([n]);
		expect(searchNodes([n], '田村')).toEqual([n]);
		expect(searchNodes([n], 'grammar')).toEqual([]);
	});
	it('handles empty networks', () => {
		expect(
			networkView({ nodes: [], links: [], stats: { nodes: 0, edges: 0, topId: null } }, 150, null)
		).toEqual({ nodes: [], links: [] });
		expect(networkView(fixture(5), 150, 'missing')).toEqual(networkView(fixture(5), 150, null));
		expect(significanceHeat([]).size).toBe(0);
	});
});
