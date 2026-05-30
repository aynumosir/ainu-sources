<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { data } = $props();
	const institutions = $derived(data.institutions);
</script>

<svelte:head><title>{m.institutions_title()} · {m.site_short()}</title></svelte:head>

<div class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.institutions_title()}</h1>
	<p class="mt-1 text-stone-600">{m.institutions_lead()}</p>

	{#if institutions.length}
		<div class="mt-6 grid gap-4 sm:grid-cols-2">
			{#each institutions as i (i.id)}
				{@const location = [i.city, i.country].filter(Boolean).join(', ')}
				<div
					class="card rounded-xl border border-stone-200 bg-paper-card p-4 transition hover:border-brand-300"
				>
					<h2 class="font-serif text-lg font-bold">
						<a href={localizeHref('/institutions/' + i.slug)} class="text-ink hover:text-brand-700"
							>{i.name}</a
						>
					</h2>
					{#if i.nameEn && i.nameEn !== i.name}
						<p class="text-sm text-stone-600">{i.nameEn}</p>
					{/if}
					{#if location}
						<p class="mt-2 text-sm text-stone-500">
							<span class="text-stone-400">{m.institution_location()}:</span>
							{location}
						</p>
					{/if}
					{#if i.url}
						<p class="mt-1 text-sm">
							<a href={i.url} target="_blank" rel="noopener noreferrer" class="link"
								>{m.institution_website()}</a
							>
						</p>
					{/if}
					<p class="mt-2 text-xs text-stone-400 tnum">
						{m.common_sources_n({ count: i.sourceCount })}
					</p>
				</div>
			{/each}
		</div>
	{:else}
		<div
			class="mt-6 rounded-xl border border-dashed border-stone-300 p-12 text-center text-stone-500"
		>
			{m.common_no_results()}
		</div>
	{/if}
</div>
