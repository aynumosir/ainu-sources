<script lang="ts">
	import { personAliases, personAliasLang } from '$lib/person-aliases';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { collectionPageJsonLd, breadcrumbJsonLd } from '$lib/seo';
	import { tl, PERSON_ROLE_LABELS, LANGUAGE_LABELS } from '$lib/constants';

	import { deLocalizeHref } from '$lib/paraglide/runtime';
	import { onMount, untrack } from 'svelte';

	let { data } = $props();
	type Person = (typeof data.people.items)[number];

	// The server renders one chunk; scrolling appends the rest from /api/people.
	let appended = $state.raw<Person[]>([]);
	let appendedHasMore = $state<boolean | undefined>();
	let loading = $state(false);
	let failed = $state(false);
	const people = $derived([...data.people.items, ...appended]);
	const hasMore = $derived(appendedHasMore ?? data.people.hasMore);
	const total = $derived(data.people.total);
	// A new search or sort drops what earlier scrolling appended.
	$effect(() => {
		void data.people;
		untrack(() => {
			appended = [];
			appendedHasMore = undefined;
			failed = false;
		});
	});
	const nextOffset = $derived(data.people.offset + people.length);

	function chunkParams(offset: number): URLSearchParams {
		const sp = new URLSearchParams(page.url.search);
		sp.delete('offset');
		if (offset > 0) sp.set('offset', String(offset));
		return sp;
	}
	const nextHref = $derived.by(() => {
		const qs = chunkParams(nextOffset).toString();
		return localizeHref(`${deLocalizeHref(page.url.pathname)}?${qs}`);
	});

	async function loadMore() {
		if (loading || !hasMore) return;
		loading = true;
		failed = false;
		try {
			const res = await fetch(`/api/people?${chunkParams(nextOffset)}`);
			if (!res.ok) throw new Error(String(res.status));
			const chunk: { items: Person[]; hasMore: boolean } = await res.json();
			const seen = new Set(people.map((p) => p.id));
			appended = [...appended, ...chunk.items.filter((p) => !seen.has(p.id))];
			appendedHasMore = chunk.hasMore;
		} catch {
			failed = true;
		} finally {
			loading = false;
		}
	}

	let sentinel = $state<HTMLElement>();
	onMount(() => {
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) void loadMore();
			},
			{ rootMargin: '600px 0px' }
		);
		$effect(() => {
			if (sentinel) io.observe(sentinel);
			return () => io.disconnect();
		});
	});

	const origin = $derived(page.url.origin);
	const seoJsonLd = $derived([
		collectionPageJsonLd({
			origin,
			path: '/people',
			name: m.people_title(),
			description: m.people_lead(),
			numberOfItems: total
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
			<span class="text-xs font-medium text-stone-500">{m.person_roles_heading()}</span>
			<select
				name="role"
				value={data.filters.role}
				onchange={submit}
				class="rounded-md border-stone-300 text-sm focus:border-brand-600 focus:ring-brand-600"
			>
				<option value="">{m.people_role_all()}</option>
				{#each data.roles as r (r)}
					<option value={r} title={r === 'author' ? m.person_role_author_help() : r === 'speaker' ? m.person_role_speaker_help() : undefined}>{tl(PERSON_ROLE_LABELS, r)}</option>
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
		<span class="tnum ml-auto self-center text-xs text-stone-400"
			>{m.people_count_n({ count: total })}</span
		>
	</form>

	{#if people.length}
		<div class="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each people as p (p.id)}
				<a href={localizeHref(`/people/${p.slug}`)} class="card flex flex-col gap-1 p-3">
					<span class="font-serif text-base font-bold leading-snug text-ink">{p.name}</span>
					{#each personAliases(p.slug) as alias (alias.name)}
						<span class="text-sm text-stone-600"><span lang={personAliasLang(alias)}>{alias.name}</span>{#if alias.nameKana}<span class="ml-1 text-xs text-stone-500">{alias.nameKana}</span>{/if} <span class="text-xs text-stone-500">（{alias.kind === 'languageVariant' && alias.language ? tl(LANGUAGE_LABELS, alias.language) : alias.kind === 'formerPenName' ? m.person_former_pen_name() : alias.kind === 'readingVariant' ? m.person_alternative_reading() : m.person_other_name()}）</span></span>
					{/each}
					{#if p.nameKana && p.nameKana !== p.name}
						<span lang="ja" class="text-sm text-stone-500">{p.nameKana}</span>
					{/if}
					{#if p.nameEn && p.nameEn !== p.name}
						<span class="text-sm text-stone-500">{p.nameEn}</span>
					{/if}
					{#if p.roles.length}
						<span class="mt-0.5 flex flex-wrap gap-1">
							{#each p.roles as role (role)}
								<span
									title={role === 'author' ? m.person_role_author_help() : role === 'speaker' ? m.person_role_speaker_help() : undefined}
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
		{#if hasMore}
			<div bind:this={sentinel} class="mt-6 flex flex-col items-center gap-2 text-sm">
				{#if failed}
					<span class="text-stone-500">{m.people_load_failed()}</span>
				{/if}
				<a
					href={nextHref}
					rel="nofollow"
					aria-busy={loading}
					onclick={(e) => {
						e.preventDefault();
						void loadMore();
					}}
					class="tnum rounded-md border border-stone-300 px-4 py-1.5 font-medium text-stone-700 hover:bg-stone-100 aria-busy:pointer-events-none aria-busy:opacity-60"
					>{loading ? m.common_loading() : m.people_load_more({ shown: nextOffset, total })}</a
				>
			</div>
		{/if}
	{:else}
		<div
			class="mt-6 rounded-xl border border-dashed border-stone-300 p-12 text-center text-stone-500"
		>
			{m.common_no_results()}
		</div>
	{/if}
</div>
