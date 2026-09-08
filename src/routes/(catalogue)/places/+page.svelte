<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import MapView from '$lib/components/MapView.svelte';
	import { filterPlaces, hasCoordinates, placeRegion } from '$lib/place-view';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import { tl, REGION_LABELS, REGION_ORDER } from '$lib/constants';

	let { data } = $props();
	const places = $derived(data.places);
	let query = $state('');
	let region = $state('');
	let mobileView = $state<'list' | 'map'>('list');
	const filtered = $derived(filterPlaces(places, query, region));
	const pins = $derived(filtered.filter(hasCoordinates));
	const regionKeys = [...REGION_ORDER, 'unassigned'];
	const availableRegions = $derived(regionKeys.filter((key) => places.some((p) => placeRegion(p) === key)));
	const groups = $derived(regionKeys.map((key) => ({
		key,
		places: filtered.filter((p) => placeRegion(p) === key)
	})).filter((group) => group.places.length));
	const regionLabel = (key: string) => key === 'unassigned' ? m.region_unassigned() : tl(REGION_LABELS, key);

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

</script>

<Seo
	title={`${m.places_title()} · ${m.site_short()}`}
	description={m.places_lead()}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.places_title()}</h1>
	<p class="mt-1 text-sm text-stone-500">{m.places_lead()}</p>

	<div class="mt-6 flex flex-wrap items-end gap-3">
		<label class="min-w-48 flex-1 text-sm font-medium text-stone-700">
			{m.common_search()}
			<input type="search" bind:value={query} placeholder={m.places_search_placeholder()}
				class="mt-1 block w-full rounded-lg border border-stone-300 bg-paper-card px-3 py-2 font-normal focus:border-brand-500 focus:ring-brand-500" />
		</label>
		<label class="text-sm font-medium text-stone-700">
			{m.filter_region()}
			<select bind:value={region} class="mt-1 block w-full rounded-lg border border-stone-300 bg-paper-card py-2 pl-3 pr-9 font-normal focus:border-brand-500 focus:ring-brand-500">
				<option value="">{m.common_all()}</option>
				{#each availableRegions as key (key)}
					<option value={key}>{regionLabel(key)}</option>
				{/each}
			</select>
		</label>
		{#if query || region}
			<button type="button" class="rounded-lg px-3 py-2 text-sm text-brand-700 hover:bg-stone-100"
				onclick={() => { query = ''; region = ''; }}>{m.filter_clear()}</button>
		{/if}
	</div>

	<div class="mt-4 flex flex-wrap items-center justify-between gap-3">
		<p class="tnum text-sm text-stone-500" role="status">{m.places_results({ count: filtered.length, mapped: pins.length })}</p>
		<div class="flex rounded-lg border border-stone-200 p-1 lg:hidden" role="group" aria-label={m.places_view()}>
			<button type="button" aria-pressed={mobileView === 'list'} aria-controls="places-list"
				class="rounded-md px-4 py-1.5 text-sm text-stone-600 aria-pressed:bg-brand-700 aria-pressed:text-white"
				onclick={() => (mobileView = 'list')}>{m.places_list()}</button>
			<button type="button" aria-pressed={mobileView === 'map'} aria-controls="places-map"
				class="rounded-md px-4 py-1.5 text-sm text-stone-600 aria-pressed:bg-brand-700 aria-pressed:text-white"
				onclick={() => (mobileView = 'map')}>{m.places_map()}</button>
		</div>
	</div>

	<div class="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
		<div id="places-list" class:hidden={mobileView !== 'list'} class="space-y-6 lg:block">
			{#each groups as group (group.key)}
				<section>
					<h2 class="font-serif text-xl font-bold text-ink">{regionLabel(group.key)}</h2>
					<div class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
						{#each group.places as p (p.id)}
							<a href={localizeHref(`/places/${p.slug}`)}
								class="group flex flex-col gap-1 rounded-xl border border-stone-200 bg-paper-card p-4 transition hover:border-brand-300 hover:shadow-sm">
								<span class="font-serif text-base font-bold leading-snug text-ink group-hover:text-brand-800">{p.name}</span>
								{#if p.nameEn && p.nameEn !== p.name}<span class="text-sm text-stone-500">{p.nameEn}</span>{/if}
								{#if p.nameAin && p.nameAin !== p.name && p.nameAin !== p.nameEn}<span lang="ain" class="text-sm text-stone-500">{p.nameAin}</span>{/if}
								<span class="tnum mt-1 text-xs text-stone-500">{m.place_sources()}: {p.sourceCount}</span>
								{#if !hasCoordinates(p)}<span class="text-xs text-stone-500">{m.places_no_coordinates()}</span>{/if}
							</a>
						{/each}
					</div>
				</section>
			{:else}
				<p class="rounded-xl border border-stone-200 p-6 text-sm text-stone-500">{m.places_empty()}</p>
			{/each}
		</div>

		<section id="places-map" aria-label={m.places_map()} class:hidden={mobileView !== 'map'} class="min-w-0 lg:sticky lg:top-32 lg:block">
			{#if pins.length}
				<MapView places={pins} height="min(68vh, 720px)" />
			{:else}
				<p class="flex min-h-64 items-center justify-center rounded-xl border border-stone-200 p-6 text-sm text-stone-500">
					{filtered.length ? m.places_no_pins() : m.places_empty()}
				</p>
			{/if}
			<p class="mt-3 text-xs leading-relaxed text-stone-500">{m.map_note()}</p>
		</section>
	</div>
</div>
