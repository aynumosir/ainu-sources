<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import { highlightSnippet } from '$lib/archive/snippets';
	import { formatYear } from '$lib/format';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	let { data } = $props();

	// Each mode answers a different question; the hint says which, in the terms
	// a reader would use, and names the input shape where it is not free text.
	const MODES = [
		{ value: 'phrase', ja: '語句', en: 'Phrase', hint: '語句をそのまま探す。 Finds the words as written.' },
		{ value: 'soft', ja: '曖昧', en: 'Fuzzy', hint: '綴りの揺れを許容する（kamuy と kamui など）。 Tolerates spelling variation, and matches across Latin and katakana.' },
		{ value: 'regex', ja: '正規表現', en: 'Regex', hint: '正規表現で探す。 Regular expression, e.g. kamuy?[ui].' },
		{ value: 'similar', ja: '類似ページ', en: 'Similar pages', hint: 'あるページに似た本文を探す。入力は revision:page 形式。 Pages whose text resembles a given page; enter revision:page.' }
	] as const;

	const activeMode = $derived(MODES.find((mode) => mode.value === data.mode) ?? MODES[0]);
</script>

<ArchiveHead title="検索 Search" />


<div class="space-y-5">
	<div class="archive-rule-dotted pb-3">
		<BilingualLabel
			tag="h1"
			stacked
			ja={archiveLabels.search.ja}
			en={archiveLabels.search.en}
			class="archive-h1"
		/>
		<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Search OCR text visible to your archive role.</p>
	</div>

	<form action="/archive/search" method="get" class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3">
		<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_16rem_auto] lg:items-end">
			<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
				Query
				<input name="q" value={data.q} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]" />
			</label>
			<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
				資料 Work
				<input name="source_slug" value={data.sourceSlug} placeholder="slug, e.g. 1996-kayano-ainu-jiten" class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]" />
			</label>
			<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.search)} class="h-10 border border-[var(--archive-gilt-text)] bg-[var(--archive-gilt-text)] px-4 text-[13px] font-semibold text-[var(--archive-paper)] hover:border-[var(--archive-gilt)] hover:bg-[var(--archive-gilt)]">
				<BilingualLabel ja={archiveLabels.search.ja} en={archiveLabels.search.en} compact />
			</button>
		</div>
		<fieldset class="mt-3 border-t border-dotted border-[var(--archive-border)] pt-3">
			<legend class="sr-only">検索方法 Search mode</legend>
			<div class="flex flex-wrap items-center gap-x-4 gap-y-2">
				{#each MODES as mode (mode.value)}
					<label class="flex items-center gap-1.5 text-[13px]">
						<input
							type="radio"
							name="mode"
							value={mode.value}
							checked={data.mode === mode.value}
							class="accent-[var(--archive-gilt-text)]"
						/>
						<BilingualLabel ja={mode.ja} en={mode.en} />
					</label>
				{/each}
			</div>
			<p class="mt-2 text-[12px] text-[var(--archive-faint-text)]">{activeMode.hint}</p>
		</fieldset>
	</form>

	{#if data.searchError}
		<p class="border border-[var(--archive-border)] bg-[var(--archive-panel)] p-3 text-[13px] text-[var(--archive-warn)]" role="alert">
			{data.searchError}
		</p>
	{/if}

	{#if data.q && data.works.length}
		<section class="space-y-2">
			<BilingualLabel
				tag="h2"
				ja="資料"
				en="Matching works"
				class="text-[15px] font-semibold [--archive-label-en-size:13px]"
			/>
			<ol class="space-y-2">
				{#each data.works as work (work.slug)}
					<li class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3">
						<a href={`/archive/sources/${work.slug}`} class="archive-title font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">{work.source.title}</a>
						{#if work.source.titleEn && work.source.titleEn !== work.source.title}
							<p class="text-[13px] text-[var(--archive-subtle)]">{work.source.titleEn}</p>
						{/if}
						<div class="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-[var(--archive-subtle)]">
							{#if work.source.author}<span>{work.source.author}</span>{/if}
							<span class="tnum">{formatYear(work.source)}</span>
						</div>
					</li>
				{/each}
			</ol>
		</section>
	{/if}

	{#if data.result}
		{#if data.q && data.result.items.length}
			<p class="text-[13px] text-[var(--archive-subtle)]">{data.result.total} hits</p>
			<ol class="space-y-3">
				{#each data.result.items as item (item.revisionId + ':' + item.variant + ':' + item.page)}
					<li class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
						<div class="space-y-1">
							<a href={`/archive/sources/${item.source.slug}`} class="archive-title font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">{item.source.title}</a>
							{#if item.source.titleEn && item.source.titleEn !== item.source.title}
								<p class="text-[13px] text-[var(--archive-subtle)]">{item.source.titleEn}</p>
							{/if}
							{#if item.source.titleAin}
								<p class="text-[13px] text-[var(--archive-subtle)]" lang="ain-Latn">{item.source.titleAin}</p>
							{/if}
						</div>
						<p class="archive-meta tnum mt-1.5 text-[12px] text-[var(--archive-subtle)]">
							{#each [item.wholeDocument ? '全文 whole document' : item.printedPage ? `p. ${item.printedPage}` : `scan p. ${item.page}`, item.variant, item.source.author, formatYear(item.source)].filter(Boolean) as part (part)}
								<span>{part}</span>
							{/each}
						</p>
						<p class="mt-3 text-[15px] leading-7">
							{#each highlightSnippet(item.snippet.text, item.snippet.offsets) as segment, index (index)}
								{#if segment.highlighted}<mark class="bg-transparent font-semibold text-[var(--archive-text)] underline decoration-[var(--archive-gilt)] decoration-2 underline-offset-2">{segment.text}</mark>{:else}{segment.text}{/if}
							{/each}
						</p>
						<div class="mt-3">
							{#if item.fileId}
								<a href={`/archive/read/${item.source.slug}/${item.fileId}?p=${item.wholeDocument ? 1 : item.page}`} aria-label={bilingualAriaLabel(archiveLabels.readPage)} class="text-[13px] font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">
									<BilingualLabel ja={archiveLabels.readPage.ja} en={archiveLabels.readPage.en} compact />
								</a>
							{:else}
								<span class="text-[13px] text-[var(--archive-subtle)]">Reader link unavailable for this hit.</span>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			{#if data.result.nextCursor}
				<a
					href={`/archive/search?q=${encodeURIComponent(data.q)}${data.sourceSlug ? `&source_slug=${encodeURIComponent(data.sourceSlug)}` : ''}&cursor=${encodeURIComponent(data.result.nextCursor)}`}
					aria-label={bilingualAriaLabel(archiveLabels.loadMore)}
					class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-paper)] px-4 py-2 text-[15px] font-medium hover:border-[var(--archive-gilt)]"
				>
					<BilingualLabel ja={archiveLabels.loadMore.ja} en={archiveLabels.loadMore.en} />
				</a>
			{/if}
		{:else if data.q}
			<div class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-10 text-center">
				<BilingualLabel
					stacked
					ja={archiveLabels.noHits.ja}
					en={archiveLabels.noHits.en}
					class="text-[17px] font-semibold"
				/>
				<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">
					{#if data.works.length}No OCR text matched; see the matching works above.{:else if data.searchableCount != null}across {data.searchableCount} approved current files{/if}
				</p>
			</div>
		{:else}
			<p class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4 text-[15px] text-[var(--archive-subtle)]">
				{#if data.searchableCount != null}{data.searchableCount} approved current files can be searched when OCR pages exist.{:else}Searchable work count is unavailable.{/if}
			</p>
		{/if}
	{/if}
</div>
