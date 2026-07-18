<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import { tl, REGION_LABELS, REGION_ORDER } from '$lib/constants';

	let { data } = $props();
	const places = $derived(data.places);

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/places',
			name: m.places_title(),
			description: m.places_lead(),
			numberOfItems: places.length
		}),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.places_title(), path: '/places' }
		])
	]);

	// Group places by region. Recognized keys come first (in REGION_ORDER),
	// then any other/empty region falls into the "unassigned" bucket.
	type Group = { key: string; places: typeof places };
	const groups = $derived.by<Group[]>(() => {
		const byRegion = new Map<string, typeof places>();
		for (const p of places) {
			const key = p.region && REGION_LABELS[p.region] && p.region !== 'other' ? p.region : '';
			if (!byRegion.has(key)) byRegion.set(key, []);
			byRegion.get(key)!.push(p);
		}
		const out: Group[] = [];
		for (const key of REGION_ORDER) {
			if (key === 'other') continue;
			if (byRegion.has(key)) out.push({ key, places: byRegion.get(key)! });
		}
		if (byRegion.has('')) out.push({ key: '', places: byRegion.get('')! });
		return out;
	});
</script>

<Seo
	title={`${m.places_title()} · ${m.site_short()}`}
	description={m.places_lead()}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-5xl px-4 py-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="font-serif text-3xl font-bold text-ink">{m.places_title()}</h1>
			<p class="mt-1 text-sm text-stone-500">{m.places_lead()}</p>
		</div>
		<a href={localizeHref('/map')} class="text-sm text-brand-700 hover:underline"
			>{m.place_on_map()} →</a
		>
	</div>

	<div class="mt-8 space-y-10">
		{#each groups as group (group.key)}
			<section>
				<h2 class="font-serif text-xl font-bold text-ink">
					{group.key ? tl(REGION_LABELS, group.key) : m.region_unassigned()}
				</h2>
				<div class="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{#each group.places as p (p.id)}
						<a
							href={localizeHref(`/places/${p.slug}`)}
							class="group flex flex-col gap-1 rounded-xl border border-stone-200 bg-paper-card p-4 transition hover:border-brand-300 hover:shadow-sm"
						>
							<span class="font-serif text-base font-bold leading-snug text-ink group-hover:text-brand-800"
								>{p.name}</span
							>
							{#if p.nameEn && p.nameEn !== p.name}
								<span class="text-sm text-stone-500">{p.nameEn}</span>
							{/if}
							<span class="tnum mt-1 text-xs text-stone-500">{m.place_sources()}: {p.sourceCount}</span>
						</a>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</div>
