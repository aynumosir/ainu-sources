<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import Seo from '$lib/components/Seo.svelte';
	import type { AuditSource } from '$lib/server/queries';

	let { data } = $props();
	const a = $derived(data.audit);

	// Summary cards (anchor to each section).
	const cards = $derived([
		{ label: 'Missing year', n: a.missingCounts.year, href: '#missing' },
		{ label: 'Missing region', n: a.missingCounts.region, href: '#missing' },
		{ label: 'Missing language', n: a.missingCounts.language, href: '#missing' },
		{ label: 'Missing summary', n: a.missingCounts.summary, href: '#missing' },
		{ label: 'Duplicate groups', n: a.duplicateGroups, href: '#duplicates' },
		{ label: 'Unverified people', n: a.weakPersonTotal, href: '#people' }
	]);

	const buckets = $derived([
		{ key: 'year', label: 'No date', list: a.missing.year, total: a.missingCounts.year },
		{ key: 'region', label: 'No region', list: a.missing.region, total: a.missingCounts.region },
		{ key: 'language', label: 'No language', list: a.missing.language, total: a.missingCounts.language },
		{ key: 'summary', label: 'No summary', list: a.missing.summary, total: a.missingCounts.summary }
	]);
</script>

<Seo title="Content audit" description="Data-quality review of the Ainu textual sources catalogue." noindex />

{#snippet srcItem(s: AuditSource)}
	<li class="flex items-baseline justify-between gap-2 py-1">
		<a href={localizeHref(`/sources/${s.slug}`)} class="truncate text-sm text-brand-700 hover:underline">
			{s.title}{#if s.titleEn && s.titleEn !== s.title}<span class="text-stone-400"> · {s.titleEn}</span>{/if}
		</a>
		<span class="shrink-0 text-xs text-stone-400">{s.yearText || '—'} · {s.type}</span>
	</li>
{/snippet}

<div class="mx-auto max-w-6xl px-4 py-8">
	<h1 class="font-serif text-3xl font-bold text-ink">Content audit</h1>
	<p class="mt-1 max-w-2xl text-sm text-stone-500">
		Data-quality review across {a.total.toLocaleString()} sources. Open to everyone, read-only — fixes
		happen on each record's edit page; batch operations are reserved for admins.
	</p>

	<!-- Summary -->
	<div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		{#each cards as c (c.label)}
			<a
				href={c.href}
				class="rounded-xl border border-stone-200 bg-paper-card p-3 transition hover:border-brand-300"
			>
				<div class="text-2xl font-bold tabular-nums {c.n ? 'text-ink' : 'text-emerald-600'}">
					{c.n.toLocaleString()}
				</div>
				<div class="mt-0.5 text-xs text-stone-500">{c.label}</div>
			</a>
		{/each}
	</div>

	<!-- Missing metadata -->
	<section id="missing" class="mt-10 scroll-mt-20">
		<h2 class="font-serif text-xl font-bold text-ink">Missing metadata</h2>
		<p class="mt-1 text-sm text-stone-500">Sources lacking fields that power browse, timeline and map.</p>
		<div class="mt-4 grid gap-6 md:grid-cols-2">
			{#each buckets as b (b.key)}
				<div class="rounded-xl border border-stone-200 p-4">
					<div class="flex items-baseline justify-between">
						<h3 class="font-sans text-sm font-semibold text-ink">{b.label}</h3>
						<span class="text-xs text-stone-400">
							{#if b.total}showing {b.list.length} of {b.total.toLocaleString()}{:else}none ✓{/if}
						</span>
					</div>
					{#if b.list.length}
						<ul class="mt-2 divide-y divide-stone-100">
							{#each b.list as s (s.slug)}{@render srcItem(s)}{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
	</section>

	<!-- Duplicates -->
	<section id="duplicates" class="mt-10 scroll-mt-20">
		<h2 class="font-serif text-xl font-bold text-ink">Likely duplicates</h2>
		<p class="mt-1 text-sm text-stone-500">
			{a.duplicateGroups.toLocaleString()} group(s) of records sharing a normalized title — review and merge or differentiate.
		</p>
		{#if a.duplicates.length}
			<div class="mt-4 space-y-3">
				{#each a.duplicates as g (g.key)}
					<div class="rounded-xl border border-stone-200 p-4">
						<div class="text-xs font-medium text-amber-700">{g.items.length} records</div>
						<ul class="mt-1 divide-y divide-stone-100">
							{#each g.items as s (s.slug)}{@render srcItem(s)}{/each}
						</ul>
					</div>
				{/each}
			</div>
		{:else}
			<p class="mt-4 rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
				No duplicate titles found ✓
			</p>
		{/if}
	</section>

	<!-- Unverified people -->
	<section id="people" class="mt-10 scroll-mt-20">
		<h2 class="font-serif text-xl font-bold text-ink">Unverified author / Wikidata links</h2>
		<p class="mt-1 text-sm text-stone-500">
			{a.weakPersonTotal.toLocaleString()} linked author(s) without a verified Wikidata identity — highest-impact first. Includes entries whose mis-matched QIDs were cleared and need a real match.
		</p>
		{#if a.weakPersons.length}
			<ul class="mt-4 grid gap-x-6 gap-y-1 rounded-xl border border-stone-200 p-4 sm:grid-cols-2">
				{#each a.weakPersons as p (p.slug)}
					<li class="flex items-baseline justify-between gap-2 py-1">
						<a href={localizeHref(`/people/${p.slug}`)} class="truncate text-sm text-brand-700 hover:underline">
							{p.name}{#if p.nameEn && p.nameEn !== p.name}<span class="text-stone-400"> · {p.nameEn}</span>{/if}
						</a>
						<span class="shrink-0 text-xs text-stone-400">{p.works} work{p.works === 1 ? '' : 's'}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-4 rounded-xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">
				Every linked author has a Wikidata identity ✓
			</p>
		{/if}
	</section>
</div>
