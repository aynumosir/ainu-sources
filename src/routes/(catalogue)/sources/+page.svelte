<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref, deLocalizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import Facets from '$lib/components/Facets.svelte';
	import SourceCard from '$lib/components/SourceCard.svelte';
	import Pagination from '$lib/components/Pagination.svelte';
	import { SORT_OPTIONS } from '$lib/filters';
	import {
		tl,
		TYPE_LABELS,
		REGION_LABELS,
		LANGUAGE_LABELS,
		SCRIPT_LABELS,
		CATEGORY_LABELS
	} from '$lib/constants';
	import { centuryLabel } from '$lib/format';

	let { data } = $props();
	const { filters, result, facets } = $derived(data);
	const user = $derived(page.data.user);

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/sources',
			name: m.nav_sources(),
			description: m.site_description(),
			numberOfItems: result.total
		}),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.nav_sources(), path: '/sources' }
		])
	]);

	const sortLabel: Record<string, () => string> = {
		'year-asc': () => m.sort_year_asc(),
		'year-desc': () => m.sort_year_desc(),
		title: () => m.sort_title(),
		'entries-desc': () => m.sort_entries(),
		updated: () => m.sort_updated()
	};

	// hidden inputs for the sort form = all current params except sort & page
	const sortHidden = $derived(
		[...page.url.searchParams.entries()].filter(([k]) => k !== 'sort' && k !== 'page')
	);

	function submitSort(e: Event) {
		(e.currentTarget as HTMLElement & { form?: HTMLFormElement }).form?.requestSubmit();
	}

	// active filter chips
	interface Chip {
		label: string;
		name: string;
		value: string;
	}
	const chips = $derived.by(() => {
		const out: Chip[] = [];
		if (filters.q) out.push({ label: `“${filters.q}”`, name: 'q', value: filters.q });
		if (filters.category)
			out.push({ label: tl(CATEGORY_LABELS, filters.category), name: 'category', value: filters.category });
		for (const c of filters.centuries ?? [])
			out.push({ label: centuryLabel(c), name: 'century', value: String(c) });
		for (const t of filters.types ?? []) out.push({ label: tl(TYPE_LABELS, t), name: 'types', value: t });
		for (const r of filters.regions ?? []) out.push({ label: tl(REGION_LABELS, r), name: 'regions', value: r });
		for (const l of filters.languages ?? []) out.push({ label: tl(LANGUAGE_LABELS, l), name: 'languages', value: l });
		for (const s of filters.scripts ?? []) out.push({ label: tl(SCRIPT_LABELS, s), name: 'scripts', value: s });
		if (filters.hasDigital) out.push({ label: m.filter_has_digital(), name: 'digital', value: '1' });
		return out;
	});

	function removeHref(name: string, value: string): string {
		const sp = new URLSearchParams(page.url.search);
		const remaining = sp.getAll(name).filter((v) => v !== value);
		sp.delete(name);
		for (const v of remaining) sp.append(name, v);
		sp.delete('page');
		const path = deLocalizeHref(page.url.pathname);
		const qs = sp.toString();
		return localizeHref(qs ? `${path}?${qs}` : path);
	}
</script>

<Seo
	title={`${m.nav_sources()} · ${m.site_short()}`}
	description={`${m.results_count({ count: result.total })} · ${m.site_tagline()}`}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-6xl px-4 py-8">
	<div class="flex flex-wrap items-end justify-between gap-3">
		<div>
			<h1 class="font-serif text-3xl font-bold text-ink">{m.nav_sources()}</h1>
			<p class="mt-1 text-sm text-stone-500">{m.results_count({ count: result.total })}</p>
		</div>
		<div class="flex items-center gap-3">
			{#if user}
				<a
					href={localizeHref('/sources/new')}
					class="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800"
					>+ {m.new_source_title()}</a
				>
			{/if}
			<form method="GET" action={localizeHref('/sources')} class="flex items-center gap-1.5">
				{#each sortHidden as [k, v] (k + v)}
					<input type="hidden" name={k} value={v} />
				{/each}
				<label for="sort" class="text-xs text-stone-500">{m.sort_label()}</label>
				<select
					id="sort"
					name="sort"
					value={filters.sort}
					onchange={submitSort}
					class="rounded-md border-stone-300 py-1.5 pl-2.5 pr-8 text-sm focus:border-brand-600 focus:ring-brand-600"
				>
					{#each SORT_OPTIONS as s (s)}
						<option value={s}>{sortLabel[s]()}</option>
					{/each}
				</select>
			</form>
		</div>
	</div>

	{#if chips.length}
		<div class="mt-4 flex flex-wrap items-center gap-2">
			{#each chips as c (c.name + c.value)}
				<a
					href={removeHref(c.name, c.value)}
					class="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100"
				>
					{c.label}
					<span aria-hidden="true" class="text-brand-400">✕</span>
				</a>
			{/each}
			<a href={localizeHref('/sources')} class="text-xs text-stone-500 hover:underline"
				>{m.filter_clear()}</a
			>
		</div>
	{/if}

	<div class="mt-6 grid gap-8 lg:grid-cols-[16rem_1fr]">
		<aside class="lg:sticky lg:top-20 lg:self-start">
			<details class="lg:open" open>
				<summary class="mb-2 cursor-pointer list-none font-serif text-base font-bold text-ink lg:hidden"
					>{m.filter_heading()}</summary
				>
				<Facets {facets} current={filters} />
			</details>
		</aside>

		<section>
			{#if result.items.length}
				<div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
					{#each result.items as source (source.id)}
						<SourceCard {source} />
					{/each}
				</div>
				<Pagination page={result.page} pageCount={result.pageCount} />
			{:else}
				<div class="rounded-xl border border-dashed border-stone-300 p-12 text-center text-stone-500">
					{m.common_no_results()}
				</div>
			{/if}
		</section>
	</div>
</div>
