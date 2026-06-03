<script lang="ts">
	import { onMount } from 'svelte';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { goto } from '$app/navigation';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
	const network = $derived(data.network);

	// ---------------------------------------------------------------------------
	// Significance is badly compressed: one outlier at 1.0, everything else packed
	// into ~0.16..0.25. A raw linear map makes the mid-band indistinguishable. We
	// instead spread nodes by their PERCENTILE RANK of significance, which evenly
	// distributes the cluster across 0..1 while keeping the top work on top.
	// `heat` (0..1) then drives both colour and part of node size.
	// ---------------------------------------------------------------------------
	const heatById = $derived.by(() => {
		const ns = network.nodes;
		const n = ns.length;
		const map = new Map<string, number>();
		if (n <= 1) {
			for (const x of ns) map.set(x.id, 1);
			return map;
		}
		// Ascending order of significance → percentile rank.
		const order = [...ns].sort((a, b) => a.significance - b.significance);
		for (let i = 0; i < order.length; i++) {
			map.set(order[i].id, i / (n - 1)); // 0 = least significant, 1 = most
		}
		return map;
	});
	const heatOf = (n: any) => heatById.get(n.id) ?? 0;

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

	// Node draw size: a generous floor so mid-band works stay clickable, plus a
	// heat term (percentile-spread, so the cluster fans out) and a sqrt(inDegree)
	// term. Heat is gamma-curved so the very top stands out without dwarfing the
	// field (percentile rank already caps the outlier's lead).
	const nodeVal = (n: any) => 2 + Math.pow(heatOf(n), 0.85) * 18 + Math.sqrt(n.inDegree ?? 0) * 6;

	const top = $derived(network.nodes.slice(0, 25));
	let container: HTMLDivElement;
	let graph: any = null;

	onMount(() => {
		let destroyed = false;
		let onResize: (() => void) | null = null;
		(async () => {
			const ForceGraph3D = (await import('3d-force-graph')).default;
			if (destroyed) return;

			// Resolve heat once on the data we hand the lib. Clone so the lib can
			// mutate (it swaps link source/target for node refs). Pre-compute
			// curvature: when both A→B and B→A exist, bow the pair apart.
			const h = heatById;
			const pairKey = (a: string, b: string) => `${a}|${b}`;
			const present = new Set(network.links.map((l) => pairKey(l.source, l.target)));
			const gdata = {
				nodes: network.nodes.map((n) => ({ ...n, __heat: h.get(n.id) ?? 0 })),
				links: network.links.map((l) => ({
					...l,
					__curv: present.has(pairKey(l.target, l.source)) ? 0.28 : 0
				}))
			};

			const endHeat = (l: any) => {
				const s = typeof l.source === 'object' ? l.source : null;
				const t = typeof l.target === 'object' ? l.target : null;
				const sh = s ? (s.__heat ?? 0) : (h.get(l.source) ?? 0);
				const th = t ? (t.__heat ?? 0) : (h.get(l.target) ?? 0);
				return Math.max(sh, th); // edge as bright as its hotter endpoint
			};

			graph = new ForceGraph3D(container)
				.backgroundColor('#0c0a09')
				.graphData(gdata)
				.nodeId('id')
				.nodeRelSize(4)
				.nodeVal(nodeVal)
				.nodeColor((n: any) => heatColor(n.__heat ?? 0))
				.nodeOpacity(0.95)
				.nodeResolution(14)
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
				// Links must read on near-black: warm brass, with opacity & width scaled
				// by the edge's hottest endpoint, plus arrows and flowing particles.
				.linkColor((l: any) => {
					const a = 0.3 + 0.55 * endHeat(l);
					return `rgba(214,168,98,${a.toFixed(2)})`;
				})
				.linkWidth((l: any) => 0.6 + 1.8 * endHeat(l))
				.linkCurvature((l: any) => l.__curv ?? 0)
				.linkOpacity(1)
				.linkDirectionalArrowLength(3.2)
				.linkDirectionalArrowRelPos(1)
				.linkDirectionalArrowColor(() => 'rgba(245,222,179,0.9)')
				.linkDirectionalParticles((l: any) => (endHeat(l) > 0.55 ? 2 : 1))
				.linkDirectionalParticleWidth((l: any) => 1 + 1.4 * endHeat(l))
				.linkDirectionalParticleSpeed(0.006)
				.linkDirectionalParticleColor(() => 'rgba(255,236,179,0.95)')
				.onNodeClick((n: any) => goto(localizeHref(`/sources/${n.slug}`)))
				.width(container.clientWidth)
				.height(container.clientHeight);

			onResize = () => graph?.width(container.clientWidth).height(container.clientHeight);
			window.addEventListener('resize', onResize);
		})();
		return () => {
			destroyed = true;
			if (onResize) window.removeEventListener('resize', onResize);
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
		const n = graph?.graphData().nodes.find((x: any) => x.id === id);
		if (n && graph) graph.cameraPosition({ x: n.x, y: n.y, z: (n.z ?? 0) + 110 }, n, 800);
	}
</script>

<Seo title={`${m.network_title()} · ${m.site_short()}`} description={m.network_lead()} />

<div class="flex h-[calc(100vh-3.5rem)] min-h-0 flex-col lg:flex-row">
	<!-- 3D graph -->
	<div class="relative min-h-[55vh] flex-1 bg-[#0c0a09] lg:min-h-0">
		<div bind:this={container} class="absolute inset-0"></div>

		<!-- Title + significance heat legend (replaces the old category swatches) -->
		<div class="pointer-events-none absolute left-4 top-4 max-w-xs">
			<h1 class="font-serif text-xl font-bold text-white drop-shadow">{m.network_title()}</h1>
			<p class="mt-1 text-xs leading-relaxed text-stone-300">{m.network_lead()}</p>

			<div class="mt-3">
				<div
					class="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-stone-400"
				>
					<span>{m.network_heat_low()}</span>
					<span class="text-stone-300">{m.network_significance()}</span>
					<span>{m.network_heat_high()}</span>
				</div>
				<div class="h-2 w-full rounded-full ring-1 ring-white/10" style="background:{HEAT_GRADIENT}"></div>
			</div>

			<p class="mt-3 text-[11px] text-stone-400">
				{m.network_stats({ works: network.stats.nodes, citations: network.stats.edges })}
			</p>
		</div>
	</div>

	<!-- Ranked significance list. min-h-0 on the flex child lets overflow-y-auto work. -->
	<aside
		class="flex min-h-0 w-full shrink-0 flex-col border-t border-stone-200 bg-paper-card lg:w-96 lg:border-l lg:border-t-0"
	>
		<div class="shrink-0 border-b border-stone-200/70 px-4 pb-3 pt-4">
			<h2 class="font-serif text-base font-bold text-ink">{m.network_ranking()}</h2>
			<p class="mt-1 text-xs text-stone-500">{m.network_ranking_lead()}</p>
		</div>

		<ol class="min-h-0 flex-1 space-y-px overflow-y-auto px-2 py-2">
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
								class="ml-auto shrink-0 text-brand-600 opacity-0 transition group-hover:opacity-100 hover:underline focus:opacity-100"
								onclick={() => focusNode(n.id)}>⊹ {m.network_focus()}</button
							>
						</span>
						<span class="mt-1 block h-1 overflow-hidden rounded-full bg-stone-100">
							<span
								class="block h-1 rounded-full"
								style="width:{Math.max(6, heat * 100)}%;background:{heatColor(heat)}"
							></span>
						</span>
					</span>
				</li>
			{/each}
		</ol>
	</aside>
</div>

