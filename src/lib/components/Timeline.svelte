<script lang="ts">
	import type { TimelinePoint } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let {
		points,
		height = 360,
		showLegend = true,
		variant = 'full'
	}: {
		points: TimelinePoint[];
		height?: number;
		showLegend?: boolean;
		variant?: 'full' | 'mini';
	} = $props();

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
		const ys = points.map((p) => p.yearStart);
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
		for (const p of points) {
			const b = Math.floor((p.yearStart - bounds.min) / binYears);
			let e = map.get(b);
			if (!e) map.set(b, (e = { total: 0, cats: {} }));
			e.total += 1;
			e.cats[p.category] = (e.cats[p.category] ?? 0) + 1;
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

	// ---- FULL: every source as a dot, arranged into per-year "spikes" --------
	// Each year is a vertical spike whose HEIGHT ∝ √(count) scaled to the plot
	// height, so the tallest spike just fills the space and nothing clips. The
	// year's dots are distributed along the spike, ordered (and colour-banded)
	// by category. Dense years → tall solid spikes; sparse years → airy dots.
	const PXY = 4.4;
	const fullW = $derived(PAD * 2 + span * PXY);
	const xf = (year: number) => PAD + (year - bounds.min) * PXY;
	const laid = $derived.by(() => {
		const groups = new Map<number, TimelinePoint[]>();
		for (const p of points) {
			const g = groups.get(p.yearStart);
			if (g) g.push(p);
			else groups.set(p.yearStart, [p]);
		}
		const maxN = Math.max(1, ...[...groups.values()].map((g) => g.length));
		const usableH = baseline - TOP;
		const out: { p: TimelinePoint; px: number; py: number; r: number; color: string }[] = [];
		for (const [year, gs] of groups) {
			gs.sort((a, b) => ORDER.indexOf(a.category as never) - ORDER.indexOf(b.category as never));
			const n = gs.length;
			const spikeH = Math.max(6, (Math.sqrt(n) / Math.sqrt(maxN)) * usableH);
			const r = n > 60 ? 1.9 : n > 25 ? 2.4 : 3.2;
			const baseX = xf(year);
			gs.forEach((p, i) => {
				const py = baseline - ((i + 0.5) / n) * spikeH;
				// gentle deterministic horizontal jitter so dense spikes read as a column, not a line
				const jx = n > 1 ? ((i % 3) - 1) * Math.min(1.6, spikeH / n / 2) : 0;
				out.push({ p, px: baseX + jx, py, r, color: colorOf(p.category) });
			});
		}
		return out;
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
		<div class="card relative overflow-x-auto">
			<svg width={fullW} {height} viewBox="0 0 {fullW} {height}" class="block" role="img" aria-label="Timeline of sources">
				{#each ticks as t (t)}
					<line x1={xf(t)} y1={TOP} x2={xf(t)} y2={baseline} stroke="var(--color-stone-200)" stroke-width={t % 100 === 0 ? 1 : 0.5} />
					<text x={xf(t)} y={height - 9} text-anchor="middle" class="tnum" font-size="10" fill="#a8a29e">{t}</text>
				{/each}
				<line x1={PAD} y1={baseline} x2={fullW - PAD + 8} y2={baseline} stroke="var(--color-stone-300)" stroke-width="1" />
				{#each laid as d (d.p.slug)}
					<a
						href={localizeHref(`/sources/${d.p.slug}`)}
						aria-label="{d.p.title} ({d.p.yearStart})"
						onmouseenter={() => (hover = { x: d.px, top: d.py - 6, label: `${d.p.yearStart} · ${d.p.titleEn || d.p.title}` })}
						onmouseleave={() => (hover = null)}
					>
						<circle cx={d.px} cy={d.py} r={d.r} fill={d.color} fill-opacity="0.85" stroke="white" stroke-width="0.6" />
					</a>
				{/each}
			</svg>
			{#if hover}
				<div class="pointer-events-none absolute z-10 w-max max-w-xs -translate-x-1/2 -translate-y-full rounded-md bg-ink px-2 py-1 text-xs text-white shadow-lg" style="left:{hover.x}px; top:{hover.top}px">
					<span class="tnum font-semibold">{hover.label}</span>
				</div>
			{/if}
		</div>
	{/if}
</div>
