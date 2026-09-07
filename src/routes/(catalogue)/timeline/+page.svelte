<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { timelineYears, timelinePage } from '$lib/timeline';
	import Pagination from '$lib/components/Pagination.svelte';
	import { tl, TYPE_LABELS } from '$lib/constants';
	import Timeline from '$lib/components/Timeline.svelte';
	import { centuryOf, centuryLabel } from '$lib/format';

	let { data } = $props();
	const points = $derived(data.points);
	const years = $derived(timelineYears(points));
	const result = $derived(timelinePage(points, page.url.searchParams.get('year'), page.url.searchParams.get('page')));

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/timeline',
			name: m.timeline_title(),
			description: m.timeline_lead(),
			numberOfItems: points.length
		}),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.timeline_title(), path: '/timeline' }
		])
	]);

	const centuries = $derived.by(() => {
		const counts = new Map<number, number>();
		for (const p of points) {
			const c = centuryOf(p.yearStart);
			if (c == null) continue;
			counts.set(c, (counts.get(c) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([century, count]) => ({ century, count }))
			.sort((a, b) => a.century - b.century);
	});
</script>

<Seo
	title={`${m.timeline_title()} · ${m.site_short()}`}
	description={m.timeline_lead()}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.timeline_title()}</h1>
	<p class="mt-1 text-sm text-stone-500">{m.timeline_lead()}</p>

	<div class="mt-6">
		<Timeline points={data.points} height={440} showLegend={true} />
	</div>

	<section id="timeline-sources" class="mt-8 scroll-mt-24">
		<h2 class="font-serif text-xl font-bold text-ink">{m.timeline_sources()}</h2>
		<p class="mt-1 text-sm text-stone-500">{m.timeline_explanation()}</p>
		<form action={localizeHref('/timeline#timeline-sources')} method="GET" class="mt-4 flex flex-wrap items-end gap-3">
			<label class="text-sm text-stone-600">
				<span class="mb-1 block">{m.timeline_year()}</span>
				<select name="year" value={result.selectedYear ?? ''} class="rounded-md border border-stone-300 bg-paper-card px-3 py-2">
					<option value="">{m.timeline_all_years()}</option>
					{#each years as row (row.year)}<option value={row.year}>{row.year} ({row.count})</option>{/each}
				</select>
			</label>
			<button type="submit" class="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800">{m.timeline_show_sources()}</button>
			<p class="py-2 text-sm text-stone-500">{m.common_sources_n({ count: result.total })}</p>
		</form>
		<ul class="mt-4 divide-y divide-stone-200">
			{#each result.items as source (source.slug)}
				<li class="py-3">
					<a href={localizeHref(`/sources/${source.slug}`)} class="flex items-baseline gap-4 text-brand-700 hover:underline">
						<span class="tnum shrink-0 text-sm text-stone-500">{source.yearStart}</span>
						<span class="font-serif font-semibold">{source.title}</span>
					</a>
					<p class="mt-1 text-xs text-stone-500">{tl(TYPE_LABELS, source.type)}{#if source.titleEn && source.titleEn !== source.title} · {source.titleEn}{/if}</p>
				</li>
			{/each}
		</ul>
		<Pagination page={result.page} pageCount={result.pageCount} fragment="timeline-sources" />
	</section>

	{#if centuries.length}
		<section class="mt-8">
			<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
				{m.timeline_by_century()}
			</h2>
			<ul class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-stone-700">
				{#each centuries as c (c.century)}
					<li>
						<span class="font-medium text-ink">{centuryLabel(c.century)}</span>
						<span class="text-stone-400">— {m.common_sources_n({ count: c.count })}</span>
					</li>
				{/each}
			</ul>
		</section>
	{/if}
</div>
