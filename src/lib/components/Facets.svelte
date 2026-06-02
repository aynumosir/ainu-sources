<script lang="ts">
	import type { Facets, SourceFilters } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import {
		tl,
		tlabel,
		TYPE_LABELS,
		TYPE_GROUPS,
		REGION_LABELS,
		LANGUAGE_LABELS,
		SCRIPT_LABELS,
		CATEGORY_LABELS,
		CATEGORY_ORDER,
		GENRE_LABELS
	} from '$lib/constants';
	import { centuryLabel } from '$lib/format';

	let { facets, current }: { facets: Facets; current: SourceFilters } = $props();

	const action = localizeHref('/sources');
	const sel = (arr?: string[]) => new Set(arr ?? []);

	const types = $derived(sel(current.types));
	const genres = $derived(sel(current.genres));
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

	// Type facet, organized into families (a big heading + its sub-types). Only
	// families/types that actually have results are shown.
	const typeCounts = $derived(new Map(facets.types.filter((b) => b.key).map((b) => [b.key, b.count])));
	const typeFamilies = $derived(
		TYPE_GROUPS.map((g) => ({
			label: g.label,
			items: g.types.filter((t) => typeCounts.has(t)).map((t) => ({ key: t, count: typeCounts.get(t)! }))
		})).filter((g) => g.items.length)
	);
	const groupedTypes = new Set(TYPE_GROUPS.flatMap((g) => g.types));
	const otherTypes = $derived(facets.types.filter((b) => b.key && !groupedTypes.has(b.key)));

	// A family checkbox selects/clears all of its visible sub-types at once.
	function toggleFamily(e: Event, familyTypes: string[]) {
		const cb = e.currentTarget as HTMLInputElement;
		const form = cb.form;
		if (!form) return;
		for (const t of familyTypes) {
			const child = form.querySelector<HTMLInputElement>(`input[name="types"][value="${CSS.escape(t)}"]`);
			if (child) child.checked = cb.checked;
		}
		form.requestSubmit();
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

{#snippet typeCheck(b: { key: string; count: number })}
	<label class="flex items-center gap-2 text-sm text-stone-700">
		<input
			type="checkbox"
			name="types"
			value={b.key}
			checked={types.has(b.key)}
			onchange={submit}
			class="rounded border-stone-300 text-brand-700 focus:ring-brand-600"
		/>
		<span class="flex-1 truncate">{tl(TYPE_LABELS, b.key)}</span>
		<span class="tnum text-xs text-stone-400">{b.count}</span>
	</label>
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

	{#if facets.types.length}
		<fieldset class="border-t border-stone-200 pt-3">
			<legend class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-stone-400"
				>{m.filter_type()}</legend
			>
			<div class="space-y-2.5">
				{#each typeFamilies as fam (fam.label.en)}
					<div>
						<label class="mb-1 flex items-center gap-2 text-[11px] font-semibold text-stone-500">
							<input
								type="checkbox"
								checked={fam.items.every((i) => types.has(i.key))}
								indeterminate={fam.items.some((i) => types.has(i.key)) &&
									!fam.items.every((i) => types.has(i.key))}
								onchange={(e) => toggleFamily(e, fam.items.map((i) => i.key))}
								class="rounded border-stone-300 text-brand-700 focus:ring-brand-600"
							/>
							<span>{tlabel(fam.label)}</span>
						</label>
						<div class="space-y-1 border-l border-stone-200 pl-2.5">
							{#each fam.items as b (b.key)}
								{@render typeCheck(b)}
							{/each}
						</div>
					</div>
				{/each}
				{#if otherTypes.length}
					<div class="space-y-1">
						{#each otherTypes as b (b.key)}
							{@render typeCheck(b)}
						{/each}
					</div>
				{/if}
			</div>
		</fieldset>
	{/if}

	{@render checkGroup('genres', m.filter_genre(), facets.genres, genres, (k) => tl(GENRE_LABELS, k))}
	{@render checkGroup('regions', m.filter_region(), facets.regions, regions, (k) => tl(REGION_LABELS, k))}
	{@render checkGroup('languages', m.filter_language(), facets.languages, languages, (k) => tl(LANGUAGE_LABELS, k))}
	{@render checkGroup('scripts', m.filter_script(), facets.scripts, scripts, (k) => tl(SCRIPT_LABELS, k))}

	<noscript>
		<button type="submit" class="w-full rounded-md bg-brand-700 px-3 py-2 text-sm font-medium text-white"
			>{m.common_search()}</button
		>
	</noscript>
</form>
