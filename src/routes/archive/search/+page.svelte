<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import { highlightSnippet } from '$lib/archive/snippets';
	import { formatYear } from '$lib/format';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	let { data } = $props();
</script>

<ArchiveHead title="検索 Search" />


<div class="space-y-5">
	<div class="archive-rule-dotted pb-3">
		<BilingualLabel
			tag="h1"
			stacked
			ja={archiveLabels.search.ja}
			en={archiveLabels.search.en}
			class="text-[27px] font-semibold"
		/>
		<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Search OCR text visible to your archive role.</p>
	</div>

	<form action="/archive/search" method="get" class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3">
		<div class="grid gap-3 md:grid-cols-[1fr_16rem_auto] md:items-end">
			<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
				Query
				<input name="q" value={data.q} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]" />
			</label>
			<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
				Source slug
				<input name="source_slug" value={data.sourceSlug} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]" />
			</label>
			<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.search)} class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]">
				<BilingualLabel ja={archiveLabels.search.ja} en={archiveLabels.search.en} inverse />
			</button>
		</div>
	</form>

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
							<div class="flex flex-wrap items-center gap-2 text-[13px] text-[var(--archive-subtle)]">
								{#if item.source.author}<span>{item.source.author}</span>{/if}
								<span class="tnum">{formatYear(item.source)}</span>
							</div>
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-[var(--archive-subtle)]">
							<span>{item.wholeDocument ? '全文（ページ非対応） / whole document' : `page ${item.page}`}</span>
							<span>{item.variant}</span>
						</div>
						<p class="mt-3 text-[15px] leading-7">
							{#each highlightSnippet(item.snippet.text, item.snippet.offsets) as segment, index (index)}
								{#if segment.highlighted}<mark class="bg-[var(--archive-accent-soft)] px-0.5 text-[var(--archive-text)]">{segment.text}</mark>{:else}{segment.text}{/if}
							{/each}
						</p>
						<div class="mt-3">
							{#if item.fileId}
								<a href={`/archive/read/${item.source.slug}/${item.fileId}?p=${item.wholeDocument ? 1 : item.page}`} aria-label={bilingualAriaLabel(archiveLabels.readPage)} class="text-[13px] font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">
									<BilingualLabel ja={archiveLabels.readPage.ja} en={archiveLabels.readPage.en} />
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
					{#if data.searchableCount != null}across {data.searchableCount} approved current files{/if}
				</p>
			</div>
		{:else}
			<p class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4 text-[15px] text-[var(--archive-subtle)]">
				{#if data.searchableCount != null}{data.searchableCount} approved current files can be searched when OCR pages exist.{:else}Searchable work count is unavailable.{/if}
			</p>
		{/if}
	{/if}
</div>
