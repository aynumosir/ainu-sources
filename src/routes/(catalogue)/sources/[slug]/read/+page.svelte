<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { breadcrumbJsonLd } from '$lib/seo';
	import { documentLabel, groupBySection, readerHref } from '$lib/text-reader/keys';

	let { data } = $props();
	const s = $derived(data.source);
	const groups = $derived(groupBySection(data.documents));
	const totalSentences = $derived(data.documents.reduce((sum, d) => sum + d.sentences, 0));
	const layerStatus = $derived.by(() => {
		const statuses = new Set(data.documents.map((d) => (d.text_layer ? d.text_layer_status : null)));
		return statuses.size === 1 ? [...statuses][0] : null;
	});
	const sections = $derived(groups.map((g) => g.section).filter((x) => x));
	const summary = $derived(
		m.reader_summary({
			documents: data.documents.length.toLocaleString('en-US'),
			sentences: totalSentences.toLocaleString('en-US')
		})
	);
	const jsonLd = $derived(
		breadcrumbJsonLd(page.url.origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.nav_sources(), path: '/sources' },
			{ name: s.title, path: `/sources/${s.slug}` },
			{ name: m.reader_contents(), path: readerHref(s.slug) }
		])
	);
</script>

<Seo title={`${m.reader_contents()} · ${s.title} · ${m.site_short()}`} description={summary} jsonLd={jsonLd} />

<article class="mx-auto max-w-3xl px-4 py-8">
	<a href={localizeHref(`/sources/${s.slug}`)} class="text-sm text-stone-500 hover:text-brand-700">← {m.reader_record()}</a>

	<header class="mt-3 border-b border-stone-200 pb-5">
		<p class="eyebrow">{m.reader_contents()}</p>
		<h1 class="mt-1 font-serif text-3xl font-bold leading-tight text-ink">{s.title}</h1>
		{#if s.titleEn && s.titleEn !== s.title}
			<p class="mt-1 text-lg text-stone-600">{s.titleEn}</p>
		{/if}
		{#if s.titleAin}
			<p class="mt-0.5 text-base text-stone-500" lang="ain-Latn">{s.titleAin}</p>
		{/if}
		{#if s.author}<p class="mt-2 text-stone-700">{s.author}</p>{/if}
		<p class="tnum mt-2 text-sm text-stone-600">
			<span>{summary}</span>{#if layerStatus}<span class="mx-1.5 text-stone-400">·</span><span
					>{layerStatus === 'reviewed' ? m.reader_modern_reviewed() : m.reader_modern_provisional()}</span
				>{/if}
		</p>
	</header>

	{#if sections.length > 1}
		<nav class="mt-5 flex flex-wrap gap-x-3 gap-y-1 text-sm" aria-label={m.reader_contents()}>
			{#each sections as section (section)}
				<a href={`#section-${section}`} class="link">{section}</a>
			{/each}
		</nav>
	{/if}

	{#each groups as group (group.section + group.docs[0].key)}
		{#if group.section}
			<h2 class="eyebrow mt-8 scroll-mt-20" id={`section-${group.section}`}>{group.section}</h2>
		{/if}
		<ol class="mt-3 divide-y divide-stone-200 border-b border-stone-200">
			{#each group.docs as doc (doc.key)}
				<li>
					<a
						href={localizeHref(readerHref(s.slug, doc.key))}
						class="flex items-baseline justify-between gap-4 py-2.5 text-ink hover:text-brand-700"
					>
						<span class="min-w-0 font-serif text-base">{documentLabel(doc)}</span>
						<span class="tnum shrink-0 text-xs text-stone-500"
							>{m.reader_sentences_n({ count: doc.sentences.toLocaleString('en-US') })}</span
						>
					</a>
				</li>
			{/each}
		</ol>
	{/each}
</article>
