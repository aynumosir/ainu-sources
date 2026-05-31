<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import MapView from '$lib/components/MapView.svelte';

	let { data } = $props();

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/map',
			name: m.map_title(),
			description: m.map_lead(),
			numberOfItems: data.places.length
		}),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.map_title(), path: '/map' }
		])
	]);
</script>

<Seo
	title={`${m.map_title()} · ${m.site_short()}`}
	description={m.map_lead()}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.map_title()}</h1>
	<p class="mt-1 max-w-2xl text-stone-600">{m.map_lead()}</p>

	<div class="mt-6">
		<MapView places={data.places} height={'72vh'} />
	</div>

	<p class="mt-3 text-sm text-stone-500">{m.map_note()}</p>
</div>
