<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { personJsonLd, breadcrumbJsonLd, truncate } from '$lib/seo';
	import Badge from '$lib/components/Badge.svelte';
	import { formatYear, personFindLinks } from '$lib/format';
	import { tl, PERSON_ROLE_LABELS } from '$lib/constants';

	let { data } = $props();
	const person = $derived(data.person);
	const sources = $derived(data.sources);
	const findLinks = $derived(personFindLinks(person));
	// Research areas = this person's works' topical tags, by frequency. Show the
	// ones backed by ≥2 works (or the top 3 if none clear the bar), capped at 6.
	const areas = $derived.by(() => {
		const all = data.areas ?? [];
		const strong = all.filter((a) => a.count >= 2);
		return (strong.length ? strong : all).slice(0, 6);
	});

	const origin = $derived(page.url.origin);
	const seoDescription = $derived(
		truncate(person.bio) ||
			`${person.nameEn && person.nameEn !== person.name ? person.nameEn + ' — ' : ''}${sources.length} ${m.person_sources()}`
	);
	const seoJsonLd = $derived([
		personJsonLd(person, origin),
		breadcrumbJsonLd(origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.people_title(), path: '/people' },
			{ name: person.name, path: `/people/${person.slug}` }
		])
	]);

	const dates = $derived(
		person.birthYear == null && person.deathYear == null
			? ''
			: `${person.birthYear ?? ''}–${person.deathYear ?? ''}`
	);
</script>

<Seo
	title={`${person.name} · ${m.site_short()}`}
	description={seoDescription}
	ogType="profile"
	jsonLd={seoJsonLd}
/>

<article class="mx-auto max-w-5xl px-4 py-8">
	<a href={localizeHref('/people')} class="text-sm text-stone-500 hover:text-brand-700"
		>← {m.people_title()}</a
	>

	<header class="mt-3 border-b border-stone-200 pb-6">
		<h1 class="font-serif text-3xl font-bold leading-tight text-ink">{person.name}</h1>
		{#if person.nameEn && person.nameEn !== person.name}
			<p class="mt-1 text-lg text-stone-600">{person.nameEn}</p>
		{/if}
		{#if dates}
			<p class="tnum mt-1 text-sm text-stone-500">{m.person_dates()}: {dates}</p>
		{/if}
		{#if person.bio}
			<p class="mt-3 leading-relaxed text-stone-700">{person.bio}</p>
		{/if}
		{#if areas.length}
			<div class="mt-4">
				<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
					{m.person_areas()}
				</h2>
				<ul class="mt-2 flex flex-wrap gap-1.5">
					{#each areas as a (a.slug)}
						<li>
							<a
								href={localizeHref(`/sources?tag=${a.slug}`)}
								class="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-sm text-brand-800 ring-1 ring-inset ring-brand-200 hover:bg-brand-100"
								>{a.name}<span class="text-xs text-brand-400">{a.count}</span></a
							>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		<div class="mt-4">
			<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
				{m.person_find_more()}
			</h2>
			<ul class="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
				{#each findLinks as l (l.label)}
					<li>
						<a
							href={l.url}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 ring-1 ring-inset transition {l.verified
								? 'bg-brand-50 text-brand-800 ring-brand-200 hover:bg-brand-100'
								: 'bg-stone-100 text-stone-600 ring-stone-200 hover:bg-stone-200 hover:text-ink'}"
							>{l.label}{l.verified ? '' : ' ⌕'} ↗</a
						>
					</li>
				{/each}
			</ul>
		</div>
	</header>

	<section class="mt-6">
		<h2 class="font-serif text-lg font-bold text-ink">{m.person_sources()}</h2>
		{#if sources.length}
			<ul class="mt-3 divide-y divide-stone-100 rounded-xl border border-stone-200 bg-paper-card">
				{#each sources as { source, role } (source.id + role)}
					<li>
						<a
							href={localizeHref(`/sources/${source.slug}`)}
							class="flex items-baseline gap-3 px-4 py-3 transition hover:bg-stone-50"
						>
							<span class="tnum w-20 shrink-0 font-serif text-sm font-bold text-stone-400"
								>{formatYear(source)}</span
							>
							<span class="min-w-0 flex-1">
								<span class="font-serif text-base text-ink">{source.title}</span>
								{#if source.titleEn && source.titleEn !== source.title}
									<span class="text-sm text-stone-500"> · {source.titleEn}</span>
								{/if}
							</span>
							<span class="hidden shrink-0 sm:block"><Badge kind="type" value={source.type} /></span>
							<span class="shrink-0 text-xs text-stone-400">{tl(PERSON_ROLE_LABELS, role)}</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="mt-2 text-sm text-stone-500">{m.common_no_results()}</p>
		{/if}
	</section>
</article>
