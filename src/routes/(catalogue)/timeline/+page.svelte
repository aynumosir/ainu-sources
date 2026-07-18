<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import Timeline from '$lib/components/Timeline.svelte';
	import { centuryOf, centuryLabel } from '$lib/format';

	let { data } = $props();
	const points = $derived(data.points);

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
