<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import { tl, PERSON_ROLE_LABELS } from '$lib/constants';

	let { data } = $props();
	const people = $derived(data.people);

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/people',
			name: m.people_title(),
			description: m.people_lead(),
			numberOfItems: people.length
		}),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.people_title(), path: '/people' }
		])
	]);

	function dates(p: { birthYear: number | null; deathYear: number | null }): string {
		if (p.birthYear == null && p.deathYear == null) return '';
		return `${p.birthYear ?? ''}–${p.deathYear ?? ''}`;
	}

	function submit(e: Event) {
		(e.currentTarget as HTMLElement).closest('form')?.requestSubmit();
	}
</script>

<Seo
	title={`${m.people_title()} · ${m.site_short()}`}
	description={m.people_lead()}
	jsonLd={seoJsonLd}
/>

<div class="mx-auto max-w-5xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.people_title()}</h1>
	<p class="mt-1 text-sm text-stone-500">{m.people_lead()}</p>

	<!-- Filter & sort toolbar -->
	<form
		method="GET"
		data-sveltekit-keepfocus
		class="mt-6 flex flex-wrap items-end gap-3 border-b border-stone-200 pb-4 text-sm"
	>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-stone-500">{m.common_search()}</span>
			<input
				type="search"
				name="q"
				value={data.filters.q}
				placeholder={m.people_search_placeholder()}
				class="w-56 rounded-md border-stone-300 text-sm focus:border-brand-600 focus:ring-brand-600"
			/>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-stone-500">{m.source_people()}</span>
			<select
				name="role"
				value={data.filters.role}
				onchange={submit}
				class="rounded-md border-stone-300 text-sm focus:border-brand-600 focus:ring-brand-600"
			>
				<option value="">{m.people_role_all()}</option>
				{#each data.roles as r (r)}
					<option value={r}>{tl(PERSON_ROLE_LABELS, r)}</option>
				{/each}
			</select>
		</label>
		<label class="flex flex-col gap-1">
			<span class="text-xs font-medium text-stone-500">{m.sort_label()}</span>
			<select
				name="sort"
				value={data.filters.sort}
				onchange={submit}
				class="rounded-md border-stone-300 text-sm focus:border-brand-600 focus:ring-brand-600"
			>
				<option value="count">{m.people_sort_count()}</option>
				<option value="name">{m.people_sort_name()}</option>
				<option value="name-desc">{m.people_sort_name_desc()}</option>
			</select>
		</label>
		<button
			type="submit"
			class="rounded-md bg-brand-700 px-3 py-1.5 font-medium text-white hover:bg-brand-800"
			>{m.common_search()}</button
		>
		{#if data.filters.q || data.filters.role || data.filters.sort !== 'count'}
			<a href={localizeHref('/people')} class="text-xs text-brand-700 hover:underline"
				>{m.filter_clear()}</a
			>
		{/if}
		<span class="ml-auto self-center text-xs text-stone-400"
			>{m.common_sources_n({ count: people.length })}</span
		>
	</form>

	{#if people.length}
		<div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each people as p (p.id)}
				<a href={localizeHref(`/people/${p.slug}`)} class="card flex flex-col gap-1 p-3">
					<span class="font-serif text-base font-bold leading-snug text-ink">{p.name}</span>
					{#if p.nameEn && p.nameEn !== p.name}
						<span class="text-sm text-stone-500">{p.nameEn}</span>
					{/if}
					{#if p.roles.length}
						<span class="mt-0.5 flex flex-wrap gap-1">
							{#each p.roles as role (role)}
								<span
									class="inline-flex items-center rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600 ring-1 ring-inset ring-stone-200"
									>{tl(PERSON_ROLE_LABELS, role)}</span
								>
							{/each}
						</span>
					{/if}
					{#if dates(p)}
						<span class="tnum text-xs text-stone-400">{m.person_dates()}: {dates(p)}</span>
					{/if}
					<span class="tnum mt-auto pt-1 text-xs text-stone-500"
						>{p.sourceCount} {m.person_sources()}</span
					>
				</a>
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
