<script lang="ts">
	import type { TimelinePoint, TimelineDensityPoint } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	type TimelineProps = {
		height?: number;
		showLegend?: boolean;
	} & (
		| {
				/** Per-source rows — the full variant groups them into linked year bars. */
				points: TimelinePoint[];
				density?: never;
				variant?: 'full';
			}
		| {
				/** Year×category counts — the mini variant bins these into density bars. */
				density: TimelineDensityPoint[];
				points?: never;
				variant: 'mini';
			}
	);

	let { points = [], density = [], height = 360, showLegend = true, variant = 'full' }: TimelineProps = $props();

	// Warm "archive" palette, by category.
	const COLORS: Record<string, string> = {
		primary: '#9a3d2c', // rubric red
		corpus: '#5b7d52', // sage / pine
		secondary: '#9a7b3f', // antique brass
		tool: '#7a6a8a' // muted plum
	};
	const ORDER = ['primary', 'corpus', 'secondary', 'tool'] as const;
	const colorOf = (c: string) => COLORS[c] ?? '#8a7a5f';
	const catLabel = (k: string) =>
		k === 'primary'
			? m.home_stat_primary()
			: k === 'corpus'
				? m.home_stat_corpus()
				: k === 'secondary'
					? m.home_stat_secondary()
					: m.home_stat_tools();

	const PAD = 36;
	const TOP = 14;
	const BOTTOM = 28;

	const bounds = $derived.by(() => {
		const ys = variant === 'mini' ? density.map((d) => d.year) : points.map((p) => p.yearStart);
		const min = ys.length ? Math.floor(Math.min(...ys) / 50) * 50 : 1600;
		const max = ys.length ? Math.ceil(Math.max(...ys) / 50) * 50 : 2050;
		return { min, max };
	});
	const span = $derived(Math.max(1, bounds.max - bounds.min));
	const baseline = $derived(height - BOTTOM);

	const ticks = $derived.by(() => {
		const step = span > 300 ? 50 : span > 120 ? 25 : 10;
		const out: number[] = [];
		for (let y = bounds.min; y <= bounds.max; y += step) out.push(y);
		return out;
	});

	// ---- MINI: composed (stacked) density bars, all genres ------------------
	let cw = $state(820);
	const innerW = $derived(Math.max(320, Math.round(cw)));
	const plotW = $derived(innerW - PAD * 2);
	const xr = (year: number) => PAD + ((year - bounds.min) / span) * plotW;

	const bins = $derived.by(() => {
		const binCount = Math.max(8, Math.floor(plotW / 9));
		const binYears = Math.max(1, Math.ceil(span / binCount));
		const map = new Map<number, { total: number; cats: Record<string, number> }>();
		for (const d of density) {
			const b = Math.floor((d.year - bounds.min) / binYears);
			let e = map.get(b);
			if (!e) map.set(b, (e = { total: 0, cats: {} }));
			e.total += d.count;
			e.cats[d.category] = (e.cats[d.category] ?? 0) + d.count;
		}
		const max = Math.max(1, ...[...map.values()].map((e) => e.total));
		const usableH = baseline - TOP;
		const bw = Math.max(1.5, (plotW / span) * binYears - (binYears > 2 ? 1.5 : 0.5));
		return [...map.entries()].map(([b, e]) => {
			const y0 = bounds.min + b * binYears;
			const totalH = Math.max(2, (Math.sqrt(e.total) / Math.sqrt(max)) * usableH);
			let yTop = baseline;
			const segs: { y: number; h: number; color: string }[] = [];
			for (const cat of ORDER) {
				const n = e.cats[cat];
				if (!n) continue;
				const h = (n / e.total) * totalH;
				yTop -= h;
				segs.push({ y: yTop, h, color: colorOf(cat) });
			}
			return { x: xr(y0), w: bw, segs, total: e.total, y0, y1: y0 + binYears - 1 };
		});
	});

	// The full chart fits the viewport. One stacked bar per year opens its source list.
	const yearly = $derived.by(() => {
		const groups = new Map<number, Record<string, number>>();
		for (const point of points) {
			const cats = groups.get(point.yearStart) ?? {};
			cats[point.category] = (cats[point.category] ?? 0) + 1;
			groups.set(point.yearStart, cats);
		}
		const maximum = Math.max(1, ...[...groups.values()].map((cats) => Object.values(cats).reduce((a, b) => a + b, 0)));
		return [...groups].sort(([a], [b]) => a - b).map(([year, cats]) => {
			const total = Object.values(cats).reduce((a, b) => a + b, 0);
			const totalHeight = Math.max(2, Math.sqrt(total / maximum) * (baseline - TOP));
			let top = baseline;
			const segments = Object.entries(cats).sort(([a], [b]) => ORDER.indexOf(a as never) - ORDER.indexOf(b as never)).map(([category, count]) => {
				const h = count / total * totalHeight;
				top -= h;
				return { y: top, h, color: colorOf(category) };
			});
			return { year, total, segments, x: xr(year), width: Math.max(1, plotW / span * 0.8) };
		});
	});

	let hover = $state<{ x: number; top: number; label: string } | null>(null);
</script>

<div class="relative" bind:clientWidth={cw}>
	{#if showLegend}
		<div class="mb-2 flex flex-wrap gap-3 text-xs text-stone-500">
			{#each ORDER as k (k)}
				<span class="inline-flex items-center gap-1.5">
					<span class="size-2.5 rounded-full" style="background:{colorOf(k)}"></span>{catLabel(k)}
				</span>
			{/each}
		</div>
	{/if}

	{#if variant === 'mini'}
		<div class="card overflow-hidden">
			<svg width="100%" {height} viewBox="0 0 {innerW} {height}" preserveAspectRatio="none" class="block" role="img" aria-label="Sources by period">
				{#each ticks as t (t)}
					<line x1={xr(t)} y1={TOP} x2={xr(t)} y2={baseline} stroke="var(--color-stone-200)" stroke-width={t % 100 === 0 ? 1 : 0.5} />
					<text x={xr(t)} y={height - 9} text-anchor="middle" class="tnum" font-size="10" fill="#a8a29e">{t}</text>
				{/each}
				<line x1={PAD} y1={baseline} x2={innerW - PAD} y2={baseline} stroke="var(--color-stone-300)" stroke-width="1" />
				{#each bins as b, i (i)}
					<g
						role="presentation"
						onmouseenter={() => (hover = { x: (b.x / innerW) * 100, top: baseline - 4, label: `${b.y0}–${b.y1} · ${b.total}` })}
						onmouseleave={() => (hover = null)}
					>
						{#each b.segs as s, j (j)}
							<rect x={b.x} y={s.y} width={b.w} height={s.h} fill={s.color} fill-opacity="0.85" />
						{/each}
					</g>
				{/each}
			</svg>
			{#if hover}
				<div class="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-ink px-2 py-1 text-xs whitespace-nowrap text-white shadow-lg" style="left:{hover.x}%; top:{hover.top}px">
					<span class="tnum">{hover.label}</span>
				</div>
			{/if}
		</div>
	{:else}
		<div class="card relative">
			<svg width="100%" {height} viewBox="0 0 {innerW} {height}" class="block" role="group" aria-label={m.timeline_title()}>
				{#each ticks as t (t)}
					<line x1={xr(t)} y1={TOP} x2={xr(t)} y2={baseline} stroke="var(--color-stone-200)" stroke-width={t % 100 === 0 ? 1 : 0.5} />
					<text x={xr(t)} y={height - 9} text-anchor="middle" class="tnum" font-size="10" fill="#a8a29e">{t}</text>
				{/each}
				<line x1={PAD} y1={baseline} x2={innerW - PAD} y2={baseline} stroke="var(--color-stone-300)" />
				{#each yearly as bar (bar.year)}
					<a href={localizeHref(`/timeline?year=${bar.year}#timeline-sources`)} aria-label={`${bar.year} · ${m.common_sources_n({ count: bar.total })}`}>
						<title>{bar.year} · {m.common_sources_n({ count: bar.total })}</title>
						{#each bar.segments as segment, i (i)}
							<rect x={bar.x - bar.width / 2} y={segment.y} width={bar.width} height={segment.h} fill={segment.color} fill-opacity="0.85" />
						{/each}
					</a>
				{/each}
			</svg>
		</div>
	{/if}
</div>
