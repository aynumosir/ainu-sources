<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { placeJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import Badge from '$lib/components/Badge.svelte';
	import { formatYear } from '$lib/format';
	import { tl, PLACE_ROLE_LABELS, REGION_LABELS, TYPE_LABELS } from '$lib/constants';

	let { data } = $props();
	const place = $derived(data.place);
	const sources = $derived(data.sources);

	const origin = $derived(page.url.origin);
	const seoDescription = $derived(
		`${place.nameEn && place.nameEn !== place.name ? place.nameEn + ' — ' : ''}${place.region ? tl(REGION_LABELS, place.region) + ' · ' : ''}${sources.length} ${m.place_sources()}`
	);
	const seoJsonLd = $derived([
		placeJsonLd(place, origin),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.places_title(), path: '/places' },
			{ name: place.name, path: `/places/${place.slug}` }
		])
	]);
</script>

<Seo
	title={`${place.name} · ${m.site_short()}`}
	description={seoDescription}
	jsonLd={seoJsonLd}
/>

<article class="mx-auto max-w-5xl px-4 py-8">
	<a href={localizeHref('/places')} class="text-sm text-stone-500 hover:text-brand-700"
		>← {m.places_title()}</a
	>

	<header class="mt-3 border-b border-stone-200 pb-6">
		<h1 class="font-serif text-3xl font-bold leading-tight text-ink">{place.name}</h1>
		{#if place.nameEn && place.nameEn !== place.name}
			<p class="mt-1 text-lg text-stone-600">{place.nameEn}</p>
		{/if}
		{#if place.region}
			<div class="mt-3 flex flex-wrap items-center gap-2">
				<Badge kind="region" value={place.region} />
			</div>
		{/if}
	</header>

	<section class="mt-6">
		<h2 class="font-serif text-lg font-bold text-ink">{m.place_sources()}</h2>
		{#if sources.length}
			<ul class="mt-4 divide-y divide-stone-200 rounded-xl border border-stone-200 bg-paper-card">
				{#each sources as { source, role } (source.id)}
					<li>
						<a
							href={localizeHref(`/sources/${source.slug}`)}
							class="group flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 transition hover:bg-stone-50"
						>
							<span class="tnum shrink-0 font-serif text-base font-bold text-stone-400 group-hover:text-brand-700"
								>{formatYear(source)}</span
							>
							<span class="font-serif font-bold leading-snug text-ink group-hover:text-brand-800"
								>{source.title}</span
							>
							<span class="text-xs text-stone-400">· {tl(TYPE_LABELS, source.type)}</span>
							{#if role}
								<span class="text-xs text-stone-400">· {tl(PLACE_ROLE_LABELS, role)}</span>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<div class="mt-4 rounded-xl border border-dashed border-stone-300 p-12 text-center text-stone-500">
				{m.common_no_results()}
			</div>
		{/if}
	</section>
</article>
