<script lang="ts">
	import { onMount } from 'svelte';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { page } from '$app/state';
	import Seo from '$lib/components/Seo.svelte';
	import { breadcrumbJsonLd } from '$lib/seo';
	import { safeUrl } from '$lib/safe-url';
	import { documentLabel, documentSection, readerHref } from '$lib/text-reader/keys';
	import { kanaOf } from '$lib/text-reader/kana';
	import { readReaderPrefs, writeReaderPrefs } from '$lib/text-reader/prefs';

	let { data } = $props();
	const s = $derived(data.source);
	const doc = $derived(data.text.document);
	const sentences = $derived(data.text.sentences);
	const title = $derived(documentLabel(doc));
	const section = $derived(documentSection(doc.key));
	const sourceUrl = $derived(safeUrl(doc.uri));
	const speaker = $derived(sentences.find((x) => x.author)?.author ?? null);
	const dialect = $derived(sentences.find((x) => x.dialect)?.dialect ?? null);
	const hasSourceSpelling = $derived(sentences.some((x) => x.source_text && x.source_text !== x.text));
	const hasTranslation = $derived(doc.translated > 0);
	const layerNote = $derived(
		doc.text_layer ? (doc.text_layer_status === 'reviewed' ? m.reader_modern_reviewed() : m.reader_modern_provisional()) : null
	);

	let showSource = $state(false);
	let showTranslation = $state(true);
	let showKana = $state(false);
	onMount(() => {
		const prefs = readReaderPrefs();
		if (prefs.source != null) showSource = prefs.source;
		if (prefs.translation != null) showTranslation = prefs.translation;
		if (prefs.kana != null) showKana = prefs.kana;
	});

	const partHref = (n: number) => localizeHref(readerHref(s.slug, doc.key, n));
	const seoTitle = $derived(`${title} · ${s.title} · ${m.site_short()}`);
	const seoDescription = $derived(sentences.slice(0, 3).map((x) => x.text).join(' '));
	const jsonLd = $derived(
		breadcrumbJsonLd(page.url.origin, [
			{ name: m.site_short(), path: '/' },
			{ name: m.nav_sources(), path: '/sources' },
			{ name: s.title, path: `/sources/${s.slug}` },
			{ name: m.reader_contents(), path: readerHref(s.slug) },
			{ name: title, path: readerHref(s.slug, doc.key) }
		])
	);
</script>

<Seo title={seoTitle} description={seoDescription} keepQuery={data.pageNo > 1} ogType="article" jsonLd={jsonLd} />

<article class="mx-auto max-w-3xl px-4 py-8">
	<nav class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-stone-500" aria-label={m.reader_contents()}>
		<a href={localizeHref(readerHref(s.slug))} class="hover:text-brand-700">← {m.reader_contents()}</a>
		<a href={localizeHref(`/sources/${s.slug}`)} class="hover:text-brand-700">{m.reader_record()}</a>
	</nav>

	<header class="mt-3 border-b border-stone-200 pb-5">
		<p class="eyebrow">{s.title}{#if section} · {section}{/if}</p>
		<h1 class="mt-1 font-serif text-3xl font-bold leading-tight text-ink">{title}</h1>
		<p class="tnum mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-stone-600">
			{#if speaker}<span>{speaker}</span>{/if}
			{#if dialect}<span>{dialect}</span>{/if}
			<span>{m.reader_sentences_n({ count: data.text.total.toLocaleString('en-US') })}</span>
			{#if data.pageCount > 1}<span>{m.reader_part({ n: String(data.pageNo), total: String(data.pageCount) })}</span>{/if}
			{#if sourceUrl}<a href={sourceUrl} rel="noopener" class="link">{m.reader_original()}</a>{/if}
		</p>
		{#if layerNote}<p class="mt-1 text-xs text-stone-500">{layerNote}</p>{/if}
	</header>

	<div
		class="sticky top-[55px] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-stone-200 bg-paper/95 px-4 py-2 backdrop-blur"
		role="group"
		aria-label={m.reader_layers()}
	>
		{#if hasSourceSpelling}
			<label class="inline-flex cursor-pointer items-center gap-1.5 text-sm text-stone-700">
				<input
					type="checkbox"
					class="rounded border-stone-300 text-brand-700 focus:ring-brand-400"
					bind:checked={showSource}
					onchange={() => writeReaderPrefs({ source: showSource })}
				/>
				{m.reader_layer_source()}
			</label>
		{/if}
		<label class="inline-flex cursor-pointer items-center gap-1.5 text-sm text-stone-700">
			<input
				type="checkbox"
				class="rounded border-stone-300 text-brand-700 focus:ring-brand-400"
				bind:checked={showKana}
				onchange={() => writeReaderPrefs({ kana: showKana })}
			/>
			{m.reader_layer_kana()}
		</label>
		{#if hasTranslation}
			<label class="inline-flex cursor-pointer items-center gap-1.5 text-sm text-stone-700">
				<input
					type="checkbox"
					class="rounded border-stone-300 text-brand-700 focus:ring-brand-400"
					bind:checked={showTranslation}
					onchange={() => writeReaderPrefs({ translation: showTranslation })}
				/>
				{m.reader_layer_translation()}
			</label>
		{/if}
	</div>

	<ol class="mt-6 space-y-4">
		{#each sentences as x (x.id)}
			<li id={`s${x.index + 1}`} class="grid scroll-mt-28 grid-cols-[2.5rem_minmax(0,1fr)] gap-x-3">
				<a
					href={`#s${x.index + 1}`}
					class="tnum pt-1.5 text-right text-xs text-stone-400 hover:text-brand-700"
					aria-label={`${x.index + 1}`}>{x.index + 1}</a
				>
				<div class="min-w-0">
					<p lang="ain-Latn" class="font-serif text-lg leading-relaxed text-ink">{x.text}</p>
					{#if showSource && x.source_text && x.source_text !== x.text}
						<p lang="ain" class="mt-0.5 text-sm leading-relaxed text-stone-500">{x.source_text}</p>
					{/if}
					{#if showKana}
						<p lang="ain-Kana" class="mt-0.5 text-base leading-relaxed text-stone-600">{kanaOf(x.text)}</p>
					{/if}
					{#if showTranslation && x.translation}
						<p lang="ja" class="mt-1 text-sm leading-relaxed text-stone-600">{x.translation}</p>
					{/if}
				</div>
			</li>
		{/each}
	</ol>

	<nav class="mt-10 flex flex-col gap-3 border-t border-stone-200 pt-5 text-sm" aria-label={m.reader_contents()}>
		{#if data.pageCount > 1}
			<div class="flex flex-wrap items-center justify-between gap-3">
				<span class="tnum text-stone-500">{m.reader_part({ n: String(data.pageNo), total: String(data.pageCount) })}</span>
				<div class="flex gap-2">
					{#if data.pageNo > 1}
						<a href={partHref(data.pageNo - 1)} class="rounded-md px-3 py-1.5 text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100">← {m.reader_part({ n: String(data.pageNo - 1), total: String(data.pageCount) })}</a>
					{/if}
					{#if data.pageNo < data.pageCount}
						<a href={partHref(data.pageNo + 1)} class="rounded-md bg-brand-700 px-3 py-1.5 font-medium text-white hover:bg-brand-800">{m.reader_continue()} →</a>
					{/if}
				</div>
			</div>
		{/if}
		<div class="flex flex-wrap items-baseline justify-between gap-3">
			{#if data.text.prev}
				<a href={localizeHref(readerHref(s.slug, data.text.prev.key))} class="min-w-0 text-stone-600 hover:text-brand-700">
					<span class="text-xs text-stone-400">← {m.reader_prev()}</span><br />
					<span class="font-serif text-base text-ink">{documentLabel(data.text.prev)}</span>
				</a>
			{:else}<span></span>{/if}
			{#if data.text.next}
				<a href={localizeHref(readerHref(s.slug, data.text.next.key))} class="min-w-0 text-right text-stone-600 hover:text-brand-700">
					<span class="text-xs text-stone-400">{m.reader_next()} →</span><br />
					<span class="font-serif text-base text-ink">{documentLabel(data.text.next)}</span>
				</a>
			{/if}
		</div>
	</nav>
</article>
