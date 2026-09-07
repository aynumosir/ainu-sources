<script lang="ts">
	import { onMount } from 'svelte';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { networkView, rankedNodes, searchNodes, significanceHeat } from '$lib/network-view';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
	const network = $derived(data.network);

	let limit = $state(150);
	let dimensions = $state(2);
	let selectedId = $state<string | null>(null);
	let query = $state('');
	let error = $state(false);
	const heatById = $derived(significanceHeat(network.nodes));
	const visible = $derived(networkView(network, limit, selectedId));
	const selected = $derived(network.nodes.find((node) => node.id === selectedId));
	const ranked = $derived(rankedNodes(network.nodes));
	const matches = $derived(searchNodes(ranked, query));
	const top = $derived(query.trim() ? matches : selected ? visible.nodes.filter((n) => n.id !== selectedId) : ranked.slice(0, 25));
	const incoming = $derived(new Set(network.links.filter((l) => l.target === selectedId).map((l) => l.source)));
	const outgoing = $derived(new Set(network.links.filter((l) => l.source === selectedId).map((l) => l.target)));
	// Warm "editorial ember" heat ramp: smouldering brown → rubric red → brass →
	// near-white-hot. Reads instantly as low→high without needing a category key.
	const HEAT_STOPS: [number, [number, number, number]][] = [
		[0.0, [86, 64, 51]], // #564033 cool ember / dim
		[0.45, [154, 61, 44]], // #9a3d2c brand rubric red
		[0.75, [201, 138, 58]], // #c98a3a brass
		[1.0, [255, 234, 168]] // #ffeaa8 white-hot highlight
	];
	function heatColor(t: number): string {
		const x = Math.min(1, Math.max(0, t));
		for (let i = 1; i < HEAT_STOPS.length; i++) {
			const [t1, c1] = HEAT_STOPS[i];
			if (x <= t1) {
				const [t0, c0] = HEAT_STOPS[i - 1];
				const f = (x - t0) / (t1 - t0 || 1);
				const ch = (a: number, b: number) => Math.round(a + (b - a) * f);
				return `rgb(${ch(c0[0], c1[0])},${ch(c0[1], c1[1])},${ch(c0[2], c1[2])})`;
			}
		}
		const [, c] = HEAT_STOPS[HEAT_STOPS.length - 1];
		return `rgb(${c[0]},${c[1]},${c[2]})`;
	}
	// CSS gradient string for the legend bar (matches the 3D ramp).
	const HEAT_GRADIENT =
		'linear-gradient(90deg,' +
		HEAT_STOPS.map(([t, c]) => `rgb(${c[0]},${c[1]},${c[2]}) ${(t * 100).toFixed(0)}%`).join(',') +
		')';

	let container: HTMLDivElement;
	let graph = $state.raw<any>(null);
	let fitPending = false;
	let layoutTicks = 0;
	let hoveredId: string | null = null;
	const endpoint = (node: any): string => typeof node === 'object' ? node.id : node;
	const touchesHover = (link: any) => hoveredId === endpoint(link.source) || hoveredId === endpoint(link.target);
	const linkColor = (link: any) => hoveredId
		? touchesHover(link) ? '#ffeaa8' : 'rgba(214,168,98,0.025)'
		: selectedId ? 'rgba(214,168,98,0.55)' : 'rgba(214,168,98,0.23)';
	const arrowLength = (link: any) => selectedId || touchesHover(link) ? 3 : 0;

	$effect(() => {
		if (!graph) return;
		const h = heatById;
		fitPending = true;
		layoutTicks = 0;
		hoveredId = null;
		graph.numDimensions(dimensions);
		graph.controls().enableRotate = dimensions === 3;
		// OrbitControls uses 2 for mouse pan, 1 for touch pan, and 0 for rotate.
		graph.controls().mouseButtons.LEFT = dimensions === 2 ? 2 : 0;
		graph.controls().touches.ONE = dimensions === 2 ? 1 : 0;
		graph.cameraPosition({ x: 0, y: 0, z: 600 }, { x: 0, y: 0, z: 0 });
		graph.graphData({
			nodes: visible.nodes.map((n) => ({ ...n, __heat: h.get(n.id) ?? 0 })),
			links: visible.links.map((l) => ({ ...l }))
		}).linkColor(linkColor).linkDirectionalArrowLength(arrowLength);
	});

	onMount(() => {
		let destroyed = false;
		let observer: ResizeObserver | null = null;
		(async () => {
			const [{ default: ForceGraph3D }, { forceCollide, forceX, forceY, forceZ }] = await Promise.all([import('3d-force-graph'), import('d3-force-3d')]);
			if (destroyed) return;
			graph = new ForceGraph3D(container, { controlType: 'orbit' })
				.backgroundColor('#0c0a09')
				.nodeId('id')
				.nodeRelSize(3.5)
				.nodeVal((n: any) => 1 + 12 * (n.__heat ?? 0))
				.nodeColor((n: any) => n.id === selectedId ? '#ffffff' : heatColor(n.__heat ?? 0))
				.nodeOpacity(0.95)
				.nodeResolution(8)
				.nodeLabel((n: any) => {
					const en = n.titleEn && n.titleEn !== n.title ? n.titleEn : null;
					const tl = langOf(n.title);
					return `<div style="max-width:300px;font:13px/1.45 sans-serif;color:#fafaf9;background:#1c1917;padding:7px 10px;border-radius:7px;border:1px solid #57534e;box-shadow:0 6px 24px rgba(0,0,0,.5)">
							<b style="color:#fff"${tl ? ` lang="${tl}"` : ''}>${escapeHtml(n.title)}</b>${n.year ? ` <span style="color:#a8a29e">(${n.year})</span>` : ''}
							${en ? `<div style="color:#a8a29e;font-style:italic;margin-top:1px">${escapeHtml(en)}</div>` : ''}
							${n.author ? `<div style="color:#a8a29e;margin-top:2px">${escapeHtml(n.author)}</div>` : ''}
							<div style="color:#fbbf24;margin-top:4px">${escapeHtml(m.network_significance())} ${(n.significance * 100).toFixed(0)} · ${escapeHtml(m.network_cited())} ${n.inDegree}×</div>
						</div>`;
				})
				.linkColor(linkColor)
				.linkWidth(0)
				.linkOpacity(1)
				.linkDirectionalArrowLength(arrowLength)
				.linkDirectionalArrowRelPos(0.85)
				.linkDirectionalArrowColor(() => '#ffeaa8')
				.linkDirectionalParticles(0)
				.showNavInfo(false)
				.warmupTicks(60)
				.cooldownTicks(100)
				.onEngineTick(() => {
					// The first tick precedes Three.js object positioning. Wait for
					// the previous frame's world bounds before measuring the graph.
					if (fitPending && ++layoutTicks === 2) {
						graph?.zoomToFit(400, 40);
					}
				})
				.onEngineStop(() => {
					if (fitPending) {
						fitPending = false;
						graph?.zoomToFit(400, 40);
					}
				})
				.onNodeHover((n: any) => {
					hoveredId = n?.id ?? null;
					graph?.linkColor(linkColor).linkDirectionalArrowLength(arrowLength);
					container.style.cursor = n ? 'pointer' : 'grab';
				})
				.onNodeClick((n: any) => focusNode(n.id))
				.width(container.clientWidth)
				.height(container.clientHeight);
			graph.d3Force('charge').strength(-80).distanceMax(250);
			graph.d3Force('link').distance(65);
			graph.d3Force('collision', forceCollide((n: any) => 3.5 * Math.cbrt(1 + 12 * (n.__heat ?? 0)) + 4));
			graph.d3Force('x', forceX(0).strength(0.04));
			graph.d3Force('y', forceY(0).strength(0.04));
			graph.d3Force('z', forceZ(0).strength(0.04));
			observer = new ResizeObserver(() => {
				graph?.width(container.clientWidth).height(container.clientHeight);
			});
			observer.observe(container);
		})().catch(() => { if (!destroyed) error = true; });
		return () => {
			destroyed = true;
			observer?.disconnect();
			graph?._destructor?.();
		};
	});

	function escapeHtml(s: string) {
		return s.replace(
			/[&<>"]/g,
			(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
		);
	}
	// Tag each title with the script it's written in so the browser picks the right
	// font + line-breaking (CJK vs Cyrillic vs Latin). The corpus mixes Japanese,
	// Russian, English and romanised-Ainu titles, so a constant lang would mis-shape
	// the majority — we detect per title from its characters instead.
	function langOf(s: string | null | undefined): string | undefined {
		if (!s) return undefined;
		if (/[぀-ヿ㐀-鿿豈-﫿]/.test(s)) return 'ja';
		if (/[Ѐ-ӿ]/.test(s)) return 'ru';
		return undefined;
	}
	function focusNode(id: string) {
		selectedId = id;
		query = '';
	}
</script>

<Seo title={`${m.network_title()} · ${m.site_short()}`} description={m.network_lead()} />


<div class="network-layout flex flex-col lg:min-h-0 lg:flex-row">
	<section class="flex min-w-0 flex-col bg-[#0c0a09] lg:min-h-0 lg:flex-1" aria-label={m.network_title()}>
		<div class="shrink-0 border-b border-white/10 px-4 py-3 text-stone-300">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<h1 class="font-serif text-xl font-bold text-white">{m.network_title()}</h1>
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<label for="network-limit">{m.network_overview()}</label>
					<select id="network-limit" class="rounded border border-stone-600 bg-stone-900 py-1 text-xs text-white" bind:value={limit} onchange={() => selectedId = null}>
						<option value={150}>{m.network_top_works({ count: 150 })}</option>
						<option value={300}>{m.network_top_works({ count: 300 })}</option>
						<option value={0}>{m.network_all_works()}</option>
					</select>
					<div class="flex overflow-hidden rounded border border-stone-600">
						<button class="px-2 py-1 hover:bg-stone-800" class:bg-stone-700={dimensions === 2} aria-pressed={dimensions === 2} onclick={() => dimensions = 2}>2D</button>
						<button class="border-l border-stone-600 px-2 py-1 hover:bg-stone-800" class:bg-stone-700={dimensions === 3} aria-pressed={dimensions === 3} onclick={() => dimensions = 3}>3D</button>
					</div>
					<button class="rounded border border-stone-600 px-2 py-1 hover:bg-stone-800 disabled:opacity-40" disabled={!graph || error} onclick={() => graph?.zoomToFit(400, 40)}>{m.network_fit()}</button>
					{#if selected}<button class="rounded border border-stone-600 px-2 py-1 hover:bg-stone-800" onclick={() => selectedId = null}>{m.network_back()}</button>{/if}
				</div>
			</div>
			<p class="mt-1 text-xs leading-relaxed text-stone-400">{m.network_lead()}</p>
			<div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-stone-400">
				<p aria-live="polite">{m.network_visible_stats({ works: visible.nodes.length, total: network.stats.nodes, citations: visible.links.length })}</p>
				<div class="flex items-center gap-2" title={m.network_significance()}>
					<span>{m.network_heat_low()}</span>
					<span class="h-1.5 w-20 rounded-full" style="background:{HEAT_GRADIENT}"></span>
					<span>{m.network_heat_high()}</span>
				</div>
			</div>
		</div>
		<div class="relative h-[55vh] min-h-72 lg:h-auto lg:min-h-0 lg:flex-1">
			<div bind:this={container} class="absolute inset-0 overflow-hidden" aria-hidden="true"></div>
			{#if error || !network.nodes.length || !graph}
				<p class="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-stone-300" role="status">
					{error ? m.network_error() : !network.nodes.length ? m.network_empty() : m.network_loading()}
				</p>
			{/if}
		</div>
	</section>

	<!-- Ranked significance list. min-h-0 on the flex child lets overflow-y-auto work. -->
	<aside
		class="flex w-full flex-col border-t border-stone-200 bg-paper-card lg:min-h-0 lg:w-80 xl:w-96 lg:shrink-0 lg:border-l lg:border-t-0"
	>
		<div class="shrink-0 border-b border-stone-200/70 px-4 pb-3 pt-4">
			<label for="network-search" class="mb-1 block text-xs text-stone-500">{m.network_search()}</label>
			<input id="network-search" type="search" bind:value={query} class="mb-3 w-full rounded-md border-stone-300 bg-paper px-3 py-2 text-sm" placeholder={m.network_search_placeholder()} />
			{#if selected}
				<div class="mb-3 rounded-md border border-stone-300 bg-paper p-3">
					<p class="mb-1 text-xs text-stone-500">{m.network_selected()}</p>
					<a class="link font-serif text-sm" href={localizeHref(`/sources/${selected.slug}`)} lang={langOf(selected.title)}>{selected.title}</a>
					<p class="mt-2 text-xs text-stone-500">{m.network_neighborhood()}</p>
				</div>
			{/if}
			<h2 class="font-serif text-base font-bold text-ink">{query.trim() ? m.network_results({ count: matches.length }) : selected ? m.network_connections() : m.network_ranking()}</h2>
			{#if !selected && !query.trim()}<p class="mt-1 text-xs text-stone-500">{m.network_ranking_lead()}</p>{/if}
		</div>

		<ol class="space-y-px px-2 py-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
			{#each top as n, i (n.id)}
				{@const hasEn = n.titleEn && n.titleEn !== n.title}
				{@const heat = heatById.get(n.id) ?? 0}
				<li class="group flex items-start gap-2.5 rounded-md px-2 py-2 hover:bg-paper-sunk/50">
					<span class="tnum w-5 shrink-0 pt-px text-right font-serif text-sm font-bold text-stone-400"
						>{i + 1}</span
					>
					<span
						class="mt-1.5 inline-block size-2.5 shrink-0 rounded-full ring-1 ring-black/10"
						style="background:{heatColor(heat)}"
						title={m.network_significance()}
					></span>
					<span class="min-w-0 flex-1">
						<a
							href={localizeHref(`/sources/${n.slug}`)}
							class="link line-clamp-2 font-serif text-sm leading-snug"
							lang={langOf(n.title)}
							title={n.title}>{n.title}</a
						>
						{#if hasEn}
							<span class="line-clamp-1 text-xs italic text-stone-400">{n.titleEn}</span>
						{/if}
						<span class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-stone-500">
							{#if n.year}<span class="tnum">{n.year}</span>{/if}
							{#if n.author}<span class="truncate">· {n.author.split(/[、,;]/)[0].trim()}</span>{/if}
							<span class="tnum">· {m.network_cited()} {n.inDegree}×</span>
							<button
								type="button"
								class="ml-auto shrink-0 text-brand-600 hover:underline"
								onclick={() => focusNode(n.id)}>⊹ {m.network_focus()}</button
							>
						</span>
						{#if selected}
							<span class="mt-1 block text-[11px] text-stone-500">{incoming.has(n.id) ? m.network_cites_selected() : ''}{incoming.has(n.id) && outgoing.has(n.id) ? ' · ' : ''}{outgoing.has(n.id) ? m.network_cited_by_selected() : ''}</span>
						{/if}
						<span class="mt-1 block h-1 overflow-hidden rounded-full bg-stone-100">
							<span
								class="block h-1 rounded-full"
								style="width:{Math.max(6, heat * 100)}%;background:{heatColor(heat)}"
							></span>
						</span>
					</span>
				</li>
			{:else}
				<li class="px-2 py-4 text-sm text-stone-500">{m.network_no_results()}</li>
			{/each}
		</ol>
	</aside>
</div>


<style>
	@media (min-width: 1024px) {
		.network-layout { height: calc(100dvh - 6rem); min-height: 32rem; }
	}
</style>
