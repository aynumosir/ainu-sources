<script lang="ts">
	import { archiveFilterHref, type ArchiveFilters } from '$lib/archive/filters';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	let { filters }: { filters: ArchiveFilters } = $props();
</script>

<form action="/archive" method="get" class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3">
	<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_0.8fr_0.8fr_0.9fr_auto] lg:items-end">
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Text
			<input name="q" value={filters.text ?? ''} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Decade
			<input name="decade" inputmode="numeric" value={filters.decade ?? ''} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Sort
			<select name="sort" value={filters.sort} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]">
				<option value="updated">Updated</option>
				<option value="title">Title</option>
				<option value="year-desc">Newest</option>
				<option value="year-asc">Oldest</option>
			</select>
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Has OCR text
			<select name="ocr" value={filters.ocr} class="mt-1 h-10 w-full rounded-none border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)]">
				<option value="any">Any</option>
				<option value="with">With text</option>
				<option value="without">Without text</option>
			</select>
		</label>
		<div class="flex items-center gap-2 sm:col-span-2 lg:col-span-1">
			<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.apply)} class="h-10 border border-[var(--archive-gilt-text)] bg-[var(--archive-gilt-text)] px-4 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt)] hover:border-[var(--archive-gilt)]">
				<BilingualLabel ja={archiveLabels.apply.ja} en={archiveLabels.apply.en} compact />
			</button>
			<a href={archiveFilterHref('/archive', { ocr: 'any', sort: 'updated' })} aria-label={bilingualAriaLabel(archiveLabels.clear)} class="flex h-10 items-center border border-[var(--archive-border)] px-3 text-[13px] font-semibold text-[var(--archive-subtle)] hover:border-[var(--archive-gilt)] hover:text-[var(--archive-gilt-text)]">
				<BilingualLabel ja={archiveLabels.clear.ja} en={archiveLabels.clear.en} compact />
			</a>
		</div>
	</div>
</form>
