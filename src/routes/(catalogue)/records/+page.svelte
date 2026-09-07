<script lang="ts">
	import { earlyRecords, recordsHref } from '$lib/records';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Seo from '$lib/components/Seo.svelte';
	import RecordsPanel from '$lib/components/RecordsPanel.svelte';
</script>

<Seo title={`${m.records_title()} · ${m.site_short()}`} description={m.records_intro()} />
<div class="mx-auto max-w-5xl px-4 py-10">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.records_title()}</h1>
	<p class="mt-3 max-w-3xl text-stone-600">{m.records_intro()}</p>
	<a class="mt-3 inline-block text-brand-700 underline" href={recordsHref('', getLocale())}>{m.records_browse()} ↗</a>
	<div class="mt-8 space-y-10">
		{#each earlyRecords as record (record.slug)}
			<article>
				<h2 class="font-serif text-2xl font-bold text-ink"><a href={localizeHref(`/sources/${record.catalogue}`)} lang="ja">{record.title}</a></h2>
				<p class="mt-1 text-sm text-stone-500">{record.titleLatin} · <a class="text-brand-700 underline" href={localizeHref(`/sources/${record.catalogue}`)}>{m.records_catalogue()}</a></p>
				<RecordsPanel catalogue={record.catalogue} compact />
			</article>
		{/each}
	</div>
	<p class="mt-8 text-sm text-stone-500">{m.records_credit()} <a class="underline" href={recordsHref('/about', getLocale())}>ERDAL ↗</a></p>
</div>
