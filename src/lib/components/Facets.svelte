<script lang="ts">
	import type { Facets, SourceFilters } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import {
		tl,
		TYPE_LABELS,
		REGION_LABELS,
		LANGUAGE_LABELS,
		SCRIPT_LABELS,
		CATEGORY_LABELS,
		CATEGORY_ORDER
	} from '$lib/constants';
	import { centuryLabel } from '$lib/format';

	let { facets, current }: { facets: Facets; current: SourceFilters } = $props();

	const action = localizeHref('/sources');
	const sel = (arr?: string[]) => new Set(arr ?? []);

	const types = $derived(sel(current.types));
	const regions = $derived(sel(current.regions));
	const languages = $derived(sel(current.languages));
	const scripts = $derived(sel(current.scripts));
	const centuries = $derived(sel((current.centuries ?? []).map(String)));

	function submit(e: Event) {
		(e.currentTarget as HTMLElement & { form?: HTMLFormElement }).form?.requestSubmit();
	}
	function catCount(key: string): number {
		return facets.categories.find((b) => b.key === key)?.count ?? 0;
	}
</script>

{#snippet checkGroup(
	name: string,
	title: string,
	buckets: { key: string; count: number }[],
	selected: Set<string>,
	labeler: (k: string) => string
)}
	{#if buckets.length}
		<fieldset class="border-t border-stone-200 pt-3">
			<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400"
				>{title}</legend
			>
			<div class="space-y-1">
				{#each buckets as b (b.key)}
					{#if b.key}
						<label class="flex items-center gap-2 text-sm text-stone-700">
							<input
								type="checkbox"
								{name}
								value={b.key}
								checked={selected.has(b.key)}
								onchange={submit}
								class="rounded border-stone-300 text-brand-700 focus:ring-brand-600"
							/>
							<span class="flex-1 truncate">{labeler(b.key)}</span>
							<span class="tnum text-xs text-stone-400">{b.count}</span>
						</label>
					{/if}
				{/each}
			</div>
		</fieldset>
	{/if}
{/snippet}

<form method="GET" {action} class="space-y-4 text-sm">
	<input type="hidden" name="q" value={current.q ?? ''} />
	<input type="hidden" name="sort" value={current.sort ?? 'year-asc'} />
	{#if current.tag}<input type="hidden" name="tag" value={current.tag} />{/if}
	{#if current.person}<input type="hidden" name="person" value={current.person} />{/if}

	<div class="flex items-center justify-between">
		<h2 class="font-serif text-base font-bold text-ink">{m.filter_heading()}</h2>
		<a href={action} class="text-xs text-brand-700 hover:underline">{m.filter_clear()}</a>
	</div>

	<label class="flex items-center gap-2 text-sm text-stone-700">
		<input
			type="checkbox"
			name="digital"
			value="1"
			checked={current.hasDigital}
			onchange={submit}
			class="rounded border-stone-300 text-brand-700 focus:ring-brand-600"
		/>
		<span>{m.filter_has_digital()}</span>
	</label>

	<fieldset class="border-t border-stone-200 pt-3">
		<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400"
			>{m.filter_category()}</legend
		>
		<div class="space-y-1">
			<label class="flex items-center gap-2 text-sm text-stone-700">
				<input type="radio" name="category" value="" checked={!current.category} onchange={submit} class="border-stone-300 text-brand-700 focus:ring-brand-600" />
				<span class="flex-1">{m.common_all()}</span>
			</label>
			{#each CATEGORY_ORDER as key (key)}
				<label class="flex items-center gap-2 text-sm text-stone-700">
					<input
						type="radio"
						name="category"
						value={key}
						checked={current.category === key}
						onchange={submit}
						class="border-stone-300 text-brand-700 focus:ring-brand-600"
					/>
					<span class="flex-1">{tl(CATEGORY_LABELS, key)}</span>
					<span class="tnum text-xs text-stone-400">{catCount(key)}</span>
				</label>
			{/each}
		</div>
	</fieldset>

	{@render checkGroup('century', m.filter_century(), facets.centuries, centuries, (k) => centuryLabel(Number(k)))}
	{@render checkGroup('types', m.filter_type(), facets.types, types, (k) => tl(TYPE_LABELS, k))}
	{@render checkGroup('regions', m.filter_region(), facets.regions, regions, (k) => tl(REGION_LABELS, k))}
	{@render checkGroup('languages', m.filter_language(), facets.languages, languages, (k) => tl(LANGUAGE_LABELS, k))}
	{@render checkGroup('scripts', m.filter_script(), facets.scripts, scripts, (k) => tl(SCRIPT_LABELS, k))}

	<noscript>
		<button type="submit" class="w-full rounded-md bg-brand-700 px-3 py-2 text-sm font-medium text-white"
			>{m.common_search()}</button
		>
	</noscript>
</form>
