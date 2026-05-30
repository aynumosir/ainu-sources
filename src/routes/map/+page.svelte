<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import MapView from '$lib/components/MapView.svelte';

	let { data } = $props();
</script>

<svelte:head><title>{m.map_title()} · {m.site_short()}</title></svelte:head>

<div class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.map_title()}</h1>
	<p class="mt-1 max-w-2xl text-stone-600">{m.map_lead()}</p>

	<div class="mt-6">
		<MapView places={data.places} height={'72vh'} />
	</div>

	<p class="mt-3 text-sm text-stone-500">{m.map_note()}</p>
</div>
