<script lang="ts">
	import { onMount } from 'svelte';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { goto } from '$app/navigation';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
	const network = $derived(data.network);

	// Category → colour (matches the source-detail badge palette).
	const CAT_COLOR: Record<string, string> = {
		primary: '#d97706', // amber-600 — first-hand records
		secondary: '#2563eb', // blue-600 — research literature
		corpus: '#059669', // emerald-600 — corpora/datasets
		tool: '#7c3aed' // violet-600 — tools/media
	};
	const CAT_LABEL: Record<string, string> = {
		primary: 'Primary sources',
		secondary: 'Research',
		corpus: 'Corpora',
		tool: 'Tools / media'
	};
	const colorOf = (c: string) => CAT_COLOR[c] ?? '#78716c';

	const top = $derived(network.nodes.slice(0, 25));
	let container: HTMLDivElement;
	let graph: any = null;

	onMount(() => {
		let destroyed = false;
		(async () => {
			const ForceGraph3D = (await import('3d-force-graph')).default;
			if (destroyed) return;
			// Clone so the lib can mutate (it replaces link source/target with node refs).
			const gdata = {
				nodes: network.nodes.map((n) => ({ ...n })),
				links: network.links.map((l) => ({ ...l }))
			};
			graph = new ForceGraph3D(container)
				.backgroundColor('#0c0a09')
				.graphData(gdata)
				.nodeId('id')
				.nodeVal((n: any) => 1 + n.significance * 60)
				.nodeColor((n: any) => colorOf(n.category))
				.nodeOpacity(0.92)
				.nodeResolution(12)
				.nodeLabel(
					(n: any) =>
						`<div style="max-width:280px;font:13px/1.4 sans-serif;color:#fff;background:#1c1917;padding:6px 9px;border-radius:6px;border:1px solid #44403c">
							<b>${escapeHtml(n.title)}</b>${n.year ? ` <span style="color:#a8a29e">(${n.year})</span>` : ''}
							<div style="color:#a8a29e;margin-top:2px">${escapeHtml(n.author ?? '')}</div>
							<div style="color:#fbbf24;margin-top:3px">significance ${(n.significance * 100).toFixed(0)} · cited ${n.inDegree}×</div>
						</div>`
				)
				.linkColor(() => 'rgba(168,162,158,0.25)')
				.linkDirectionalArrowLength(2.5)
				.linkDirectionalArrowRelPos(1)
				.linkDirectionalParticles((l: any) => 0)
				.linkWidth(0.4)
				.onNodeClick((n: any) => goto(localizeHref(`/sources/${n.slug}`)))
				.width(container.clientWidth)
				.height(container.clientHeight);

			const onResize = () => graph?.width(container.clientWidth).height(container.clientHeight);
			window.addEventListener('resize', onResize);
			destroyed = false;
		})();
		return () => {
			destroyed = true;
			graph?._destructor?.();
		};
	});

	function escapeHtml(s: string) {
		return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
	}
	function focusNode(id: string) {
		const n = graph?.graphData().nodes.find((x: any) => x.id === id);
		if (n && graph) graph.cameraPosition({ x: n.x, y: n.y, z: (n.z ?? 0) + 120 }, n, 800);
	}
</script>

<Seo
	title={`${m.network_title()} · ${m.site_short()}`}
	description={m.network_lead()}
/>

<div class="flex h-[calc(100vh-3.5rem)] flex-col lg:flex-row">
	<!-- 3D graph -->
	<div class="relative min-h-[55vh] flex-1 bg-[#0c0a09] lg:min-h-0">
		<div bind:this={container} class="absolute inset-0"></div>
		<div class="pointer-events-none absolute left-4 top-4 max-w-xs">
			<h1 class="font-serif text-xl font-bold text-white">{m.network_title()}</h1>
			<p class="mt-1 text-xs text-stone-300">{m.network_lead()}</p>
			<div class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-stone-300">
				{#each Object.entries(CAT_COLOR) as [k, c] (k)}
					<span class="inline-flex items-center gap-1"
						><span class="inline-block size-2.5 rounded-full" style="background:{c}"></span>{CAT_LABEL[k]}</span
					>
				{/each}
			</div>
			<p class="mt-2 text-[11px] text-stone-400">
				{network.stats.nodes} works · {network.stats.edges} citations · node size = PageRank
			</p>
		</div>
	</div>

	<!-- Ranked significance list -->
	<aside class="w-full shrink-0 overflow-y-auto border-t border-stone-200 bg-paper-card p-4 lg:w-96 lg:border-l lg:border-t-0">
		<h2 class="font-serif text-base font-bold text-ink">{m.network_ranking()}</h2>
		<p class="mt-1 text-xs text-stone-500">{m.network_ranking_lead()}</p>
		<ol class="mt-3 space-y-1.5">
			{#each top as n, i (n.id)}
				<li class="flex items-start gap-2 text-sm">
					<span class="tnum w-5 shrink-0 text-right font-serif text-xs font-bold text-stone-400">{i + 1}</span>
					<span class="mt-1 inline-block size-2 shrink-0 rounded-full" style="background:{colorOf(n.category)}"></span>
					<span class="min-w-0 flex-1">
						<a href={localizeHref(`/sources/${n.slug}`)} class="link font-serif leading-snug">{n.title}</a>
						<span class="block text-xs text-stone-400">
							{n.year ?? ''}{n.author ? ` · ${n.author.split(/[、,]/)[0]}` : ''} · cited {n.inDegree}×
							<button type="button" class="ml-1 text-brand-600 hover:underline" onclick={() => focusNode(n.id)}>⊹ focus</button>
						</span>
						<span class="mt-0.5 block h-1 rounded-full bg-stone-100">
							<span class="block h-1 rounded-full bg-brand-500" style="width:{Math.max(4, n.significance * 100)}%"></span>
						</span>
					</span>
				</li>
			{/each}
		</ol>
	</aside>
</div>
