<script lang="ts">
	import { archiveFilterHref, type ArchiveFilters } from '$lib/archive/filters';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	let { filters }: { filters: ArchiveFilters } = $props();
</script>

<form action="/archive" method="get" class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3">
	<div class="grid gap-3 md:grid-cols-[1.5fr_1fr_0.8fr_0.8fr_auto] md:items-end">
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Text
			<input name="q" value={filters.text ?? ''} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Dialect
			<input name="dialect" value={filters.dialect ?? ''} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Decade
			<input name="decade" inputmode="numeric" value={filters.decade ?? ''} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Sort
			<select name="sort" value={filters.sort} class="mt-1 w-full border-[var(--archive-border)] bg-[var(--archive-panel)] text-[15px] text-[var(--archive-text)]">
				<option value="updated">Updated</option>
				<option value="title">Title</option>
				<option value="year-desc">Newest</option>
				<option value="year-asc">Oldest</option>
			</select>
		</label>
		<div class="flex items-center gap-3">
			<label class="flex items-center gap-2 text-[13px] text-[var(--archive-subtle)]">
				<input type="checkbox" name="searchable" value="1" checked={filters.searchableOnly} class="rounded border-[var(--archive-border)] text-[var(--archive-accent)]" />
				Searchable
			</label>
			<button type="submit" aria-label={bilingualAriaLabel(archiveLabels.apply)} class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]">
				<BilingualLabel ja={archiveLabels.apply.ja} en={archiveLabels.apply.en} inverse />
			</button>
			<a href={archiveFilterHref('/archive', { searchableOnly: false, sort: 'updated' })} aria-label={bilingualAriaLabel(archiveLabels.clear)} class="text-[13px] text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">
				<BilingualLabel ja={archiveLabels.clear.ja} en={archiveLabels.clear.en} />
			</a>
		</div>
	</div>
</form>
