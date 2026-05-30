<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { tl, TYPE_LABELS } from '$lib/constants';
	import { formatYear } from '$lib/format';

	let { data } = $props();
	const institution = $derived(data.institution);
	const sources = $derived(data.sources);
	const location = $derived(
		[institution.city, institution.country].filter(Boolean).join(', ')
	);
</script>

<svelte:head><title>{institution.name} · {m.site_short()}</title></svelte:head>

<article class="mx-auto max-w-5xl px-4 py-8">
	<a href={localizeHref('/institutions')} class="text-sm text-stone-500 hover:text-brand-700"
		>← {m.institutions_title()}</a
	>

	<header class="mt-3 border-b border-stone-200 pb-6">
		<h1 class="font-serif text-3xl font-bold leading-tight text-ink">{institution.name}</h1>
		{#if institution.nameEn && institution.nameEn !== institution.name}
			<p class="mt-1 text-lg text-stone-600">{institution.nameEn}</p>
		{/if}
		{#if location}
			<p class="mt-2 text-sm text-stone-500">
				<span class="text-stone-400">{m.institution_location()}:</span>
				{location}
			</p>
		{/if}
		{#if institution.url}
			<p class="mt-1 text-sm">
				<a href={institution.url} target="_blank" rel="noopener noreferrer" class="link"
					>{m.institution_website()}</a
				>
			</p>
		{/if}
	</header>

	<section class="mt-6">
		<h2 class="font-serif text-lg font-bold text-ink">{m.institution_sources()}</h2>
		{#if sources.length}
			<ul class="mt-3 divide-y divide-stone-200">
				{#each sources as { source } (source.id)}
					<li class="py-2.5">
						<a
							href={localizeHref(`/sources/${source.slug}`)}
							class="flex items-baseline gap-3"
						>
							<span class="tnum w-24 shrink-0 text-sm text-stone-400">{formatYear(source)}</span>
							<span class="min-w-0">
								<span class="link font-medium">{source.title}</span>
								<span class="text-xs text-stone-400"> · {tl(TYPE_LABELS, source.type)}</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-stone-500">{m.common_no_results()}</p>
		{/if}
	</section>
</article>
