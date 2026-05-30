<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Badge from '$lib/components/Badge.svelte';
	import { formatYear, formatCount, asArray, youtubeId } from '$lib/format';
	import {
		tl,
		TYPE_LABELS,
		REGION_LABELS,
		LANGUAGE_LABELS,
		SCRIPT_LABELS,
		LINK_TYPE_LABELS,
		PERSON_ROLE_LABELS,
		PLACE_ROLE_LABELS,
		RELATION_TYPE_LABELS,
		YEAR_CERTAINTY_LABELS
	} from '$lib/constants';

	let { data } = $props();
	const d = $derived(data.detail);
	const s = $derived(d.source);
	const langs = $derived(asArray(s.languages));
	const scripts = $derived(asArray(s.scripts));
	const alt = $derived(asArray(s.altTitles));
	// Any links that resolve to an embeddable YouTube video.
	const videos = $derived(
		d.links
			.map((l) => ({ link: l, id: youtubeId(l.url) }))
			.filter((v): v is { link: (typeof d.links)[number]; id: string } => v.id !== null)
	);
</script>

<svelte:head><title>{s.title} · {m.site_short()}</title></svelte:head>

<article class="mx-auto max-w-5xl px-4 py-8">
	<a href={localizeHref('/sources')} class="text-sm text-stone-500 hover:text-brand-700"
		>← {m.nav_sources()}</a
	>

	<header class="mt-3 border-b border-stone-200 pb-6">
		<div class="flex flex-wrap items-center gap-2">
			<Badge kind="category" value={s.category} />
			<Badge kind="type" value={s.type} />
			{#if s.region}<Badge kind="region" value={s.region} />{/if}
		</div>
		<div class="mt-3 flex items-baseline gap-3">
			<span class="tnum font-serif text-2xl font-bold text-stone-400">{formatYear(s)}</span>
			<h1 class="font-serif text-3xl font-bold leading-tight text-ink">{s.title}</h1>
		</div>
		{#if s.titleEn && s.titleEn !== s.title}
			<p class="mt-1 text-lg text-stone-600">{s.titleEn}</p>
		{/if}
		{#if s.titleAin}
			<p class="mt-0.5 text-base text-stone-500" lang="ain-Latn">{s.titleAin}</p>
		{/if}
		{#if alt.length}
			<p class="mt-1 text-sm text-stone-500">{m.source_alt_titles()}: {alt.join(' · ')}</p>
		{/if}
		{#if s.author}<p class="mt-2 text-stone-700">{s.author}</p>{/if}

		<div class="mt-4 flex flex-wrap items-center gap-2 text-sm">
			<a
				href={localizeHref(`/sources/${s.slug}/edit`)}
				class="rounded-md bg-brand-700 px-3 py-1.5 font-medium text-white hover:bg-brand-800"
				>{m.source_edit()}</a
			>
			<a
				href={localizeHref(`/sources/${s.slug}/history`)}
				class="rounded-md px-3 py-1.5 font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
				>{m.source_history()} ({d.revisionCount})</a
			>
			<a
				href="/sources/{s.slug}/cite.bib"
				class="rounded-md px-3 py-1.5 font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
				>BibTeX</a
			>
			<a
				href="/sources/{s.slug}/cite.json"
				class="rounded-md px-3 py-1.5 font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
				>CSL-JSON</a
			>
		</div>
	</header>

	<div class="mt-6 grid gap-10 md:grid-cols-[1fr_18rem]">
		<div class="min-w-0 space-y-8">
			{#if videos.length}
				<section>
					<h2 class="font-serif text-lg font-bold text-ink">{m.source_watch()}</h2>
					<div class="mt-3 space-y-4">
						{#each videos as v (v.link.id)}
							<figure>
								<div class="aspect-video w-full overflow-hidden rounded-xl border border-stone-200 bg-ink">
									<iframe
										class="size-full"
										src="https://www.youtube-nocookie.com/embed/{v.id}"
										title={v.link.label || s.title}
										loading="lazy"
										referrerpolicy="strict-origin-when-cross-origin"
										allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
										allowfullscreen
									></iframe>
								</div>
								{#if v.link.label}
									<figcaption class="mt-1.5 text-sm text-stone-500">{v.link.label}</figcaption>
								{/if}
							</figure>
						{/each}
					</div>
				</section>
			{/if}
			{#if s.summary}
				<section>
					<h2 class="font-serif text-lg font-bold text-ink">{m.source_summary()}</h2>
					<p class="mt-2 leading-relaxed text-stone-700">{s.summary}</p>
				</section>
			{/if}
			{#if s.notes}
				<section>
					<h2 class="font-serif text-lg font-bold text-ink">{m.source_notes()}</h2>
					<p class="prose-notes mt-2 text-stone-700">{s.notes}</p>
				</section>
			{/if}

			<section>
				<h2 class="font-serif text-lg font-bold text-ink">{m.source_biblio()}</h2>
				<dl class="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
					{#snippet row(label: string, value: string)}
						{#if value}
							<dt class="text-stone-500">{label}</dt>
							<dd class="text-stone-800">{value}</dd>
						{/if}
					{/snippet}
					{@render row(m.source_author(), s.author ?? '')}
					{@render row(
						m.source_date(),
						formatYear(s) + (s.yearCertainty && s.yearCertainty !== 'exact' ? ` (${tl(YEAR_CERTAINTY_LABELS, s.yearCertainty)})` : '')
					)}
					{@render row(m.source_dialect(), s.dialect ?? '')}
					{@render row(m.source_region(), s.region ? tl(REGION_LABELS, s.region) : '')}
					{@render row(m.source_type(), tl(TYPE_LABELS, s.type))}
					{@render row(m.source_languages(), langs.map((l) => tl(LANGUAGE_LABELS, l)).join(', '))}
					{@render row(m.source_scripts(), scripts.map((x) => tl(SCRIPT_LABELS, x)).join(', '))}
					{@render row(m.source_entries(), formatCount(s.entryCount, s.entryCountLabel))}
					{@render row(m.source_holding(), s.holdingInstitution ?? '')}
					{@render row(m.source_call_number(), s.callNumber ?? '')}
					{@render row(m.source_license(), s.license ?? '')}
					{@render row(m.source_reliability(), s.reliability ?? '')}
				</dl>
			</section>

			<section>
				<h2 class="font-serif text-lg font-bold text-ink">{m.source_digital()}</h2>
				{#if d.links.length}
					<ul class="mt-3 space-y-2">
						{#each d.links as link (link.id)}
							<li class="flex items-baseline gap-2 text-sm">
								<span
									class="inline-flex shrink-0 items-center rounded bg-stone-100 px-1.5 py-0.5 text-xs font-medium text-stone-600 ring-1 ring-inset ring-stone-200"
									>{tl(LINK_TYPE_LABELS, link.type)}</span
								>
								<a href={link.url} target="_blank" rel="noopener noreferrer" class="link break-all"
									>{link.label || link.url}</a
								>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="mt-2 text-sm text-stone-500">{m.source_no_links()}</p>
				{/if}
			</section>
		</div>

		<aside class="space-y-6 text-sm md:border-l md:border-stone-200 md:pl-6">
			{#if d.persons.length}
				<div>
					<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
						{m.source_people()}
					</h2>
					<ul class="mt-2 space-y-1">
						{#each d.persons as p (p.id)}
							<li>
								<a href={localizeHref(`/people/${p.slug}`)} class="link">{p.name}</a>
								<span class="text-xs text-stone-400">· {tl(PERSON_ROLE_LABELS, p.role)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if d.places.length}
				<div>
					<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
						{m.source_places()}
					</h2>
					<ul class="mt-2 space-y-1">
						{#each d.places as p (p.id)}
							<li>
								<a href={localizeHref(`/places/${p.slug}`)} class="link">{p.name}</a>
								<span class="text-xs text-stone-400">· {tl(PLACE_ROLE_LABELS, p.role)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if d.institutions.length}
				<div>
					<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
						{m.source_institutions()}
					</h2>
					<ul class="mt-2 space-y-1">
						{#each d.institutions as inst (inst.id)}
							<li><a href={localizeHref(`/institutions/${inst.slug}`)} class="link">{inst.name}</a></li>
						{/each}
					</ul>
				</div>
			{/if}

			{#if d.tags.length}
				<div>
					<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
						{m.source_tags()}
					</h2>
					<div class="mt-2 flex flex-wrap gap-1.5">
						{#each d.tags as t (t.id)}
							<a
								href={localizeHref(`/sources?tag=${t.slug}`)}
								class="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600 ring-1 ring-inset ring-stone-200 hover:bg-stone-200"
								>{t.name}</a
							>
						{/each}
					</div>
				</div>
			{/if}

			{#if d.related.length}
				<div>
					<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
						{m.source_related()}
					</h2>
					<ul class="mt-2 space-y-1">
						{#each d.related as r (r.relation.id)}
							<li>
								<a href={localizeHref(`/sources/${r.source.slug}`)} class="link">{r.source.title}</a>
								<span class="text-xs text-stone-400">· {tl(RELATION_TYPE_LABELS, r.relation.type)}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div>
				<h2 class="font-sans text-xs font-semibold uppercase tracking-wide text-stone-400">
					{m.source_provenance()}
				</h2>
				<p class="mt-2 text-xs text-stone-500">
					{m.source_provenance_note()}
					<span class="font-mono">{s.provenanceRepo}</span>
					{#if s.provenancePath}<br /><span class="break-all font-mono text-stone-400">{s.provenancePath}</span>{/if}
				</p>
			</div>
		</aside>
	</div>
</article>
