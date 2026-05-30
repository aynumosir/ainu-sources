<script lang="ts">
	import type { Source } from '$lib/server/db/schema';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { formatYear, formatCount, asArray } from '$lib/format';
	import { tl, TYPE_LABELS, REGION_LABELS, CATEGORY_ACCENT } from '$lib/constants';

	let { source }: { source: Source } = $props();

	const year = $derived(formatYear(source));
	const langs = $derived(asArray(source.languages));
	const accent = $derived(CATEGORY_ACCENT[source.category] ?? 'bg-stone-100 text-stone-700 ring-stone-300');
</script>

<a
	href={localizeHref(`/sources/${source.slug}`)}
	class="group flex flex-col gap-2 rounded-xl border border-stone-200 bg-paper-card p-4 transition hover:border-brand-300 hover:shadow-sm"
>
	<div class="flex items-start justify-between gap-2">
		<span class="tnum shrink-0 font-serif text-lg font-bold text-stone-400 group-hover:text-brand-700"
			>{year}</span
		>
		<span
			class="inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset {accent}"
			>{tl(TYPE_LABELS, source.type)}</span
		>
	</div>
	<h3 class="font-serif text-base font-bold leading-snug text-ink group-hover:text-brand-800">
		{source.title}
	</h3>
	{#if source.titleEn && source.titleEn !== source.title}
		<p class="-mt-1 text-sm text-stone-500">{source.titleEn}</p>
	{/if}
	<div class="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
		{#if source.author}<span class="truncate">{source.author}</span>{/if}
		{#if source.region}<span class="text-stone-400">·</span><span>{tl(REGION_LABELS, source.region)}</span>{/if}
		{#if source.entryCount}<span class="text-stone-400">·</span><span class="tnum"
				>{formatCount(source.entryCount, source.entryCountLabel)}</span
			>{/if}
		{#if langs.length}<span class="text-stone-400">·</span><span class="uppercase tracking-wide">{langs.join(' · ')}</span>{/if}
	</div>
</a>
