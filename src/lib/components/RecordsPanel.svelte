<script lang="ts">
	import { recordsForCatalogue, recordsHref } from '$lib/records';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	let { catalogue }: { catalogue: string } = $props();
	const records = $derived(recordsForCatalogue(catalogue));
</script>

{#if records.length}
	<section class="mt-6 rounded-xl border border-brand-200 bg-paper-card p-5" aria-label={m.records_title()}>
		<h2 class="font-serif text-xl font-bold text-ink">{m.records_title()}</h2>
		<p class="mt-2 text-sm text-stone-600">{m.records_intro()}</p>
		{#each records as record (record.slug)}
			{#if record.kind === 'wordlist' && record.catalogue === catalogue}
				<a class="mt-3 inline-block font-medium text-brand-700 underline" href={recordsHref(`/sources/${record.slug}/entries`, getLocale())}>{m.records_entries()} ↗</a>
			{/if}
			<ul class="mt-4 grid gap-3 sm:grid-cols-2">
				{#each record.units as unit (unit.slug)}
					<li class="rounded-lg border border-stone-200 p-4">
						<h3 class="font-medium text-ink">{getLocale() === 'ja' ? unit.holder : unit.holderEn}{#if unit.label} · <span lang="ja">{unit.label}</span>{/if}</h3>
						{#if unit.title}<p lang="ja" class="mt-1 text-sm">{unit.title}</p>{/if}
						{#if unit.shelfmark}<p class="mt-1 text-xs text-stone-500">{unit.shelfmark}</p>{/if}
						<p class="mt-2 text-sm text-stone-600">{m.records_pages({ count: unit.pages })}{#if unit.items > 0} · {m.records_items({ count: unit.items })}{/if}</p>
						<div class="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-sm">
							<a class="font-medium text-brand-700 underline" href={recordsHref(`/sources/${record.slug}/${unit.slug}/1`, getLocale())}>{m.records_read()} ↗</a>
							<a class="text-brand-700 underline" href={recordsHref(`/export/tei/${record.slug}/${unit.slug}.xml`)}>TEI XML</a>
							{#if unit.catalogue && unit.catalogue !== catalogue}
								<a class="text-brand-700 underline" href={localizeHref(`/sources/${unit.catalogue}`)}>{m.records_catalogue()}</a>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/each}
		<p class="mt-4 text-xs text-stone-500">{m.records_credit()} <a class="underline" href={recordsHref('/about', getLocale())}>{m.project_early_records()} ↗</a></p>
	</section>
{/if}
