<script lang="ts">
	import { archiveFilterHref, type ArchiveFilters } from '$lib/archive/filters';

	let { filters }: { filters: ArchiveFilters } = $props();
</script>

<form action="/archive" method="get" class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-3">
	<div class="grid gap-3 md:grid-cols-[1.5fr_1fr_0.8fr_0.8fr_auto] md:items-end">
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Text
			<input name="q" value={filters.text ?? ''} class="mt-1 w-full rounded-md border-[var(--archive-border)] bg-[var(--archive-surface)] text-[15px]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Dialect
			<input name="dialect" value={filters.dialect ?? ''} class="mt-1 w-full rounded-md border-[var(--archive-border)] bg-[var(--archive-surface)] text-[15px]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Decade
			<input name="decade" inputmode="numeric" value={filters.decade ?? ''} class="mt-1 w-full rounded-md border-[var(--archive-border)] bg-[var(--archive-surface)] text-[15px]" />
		</label>
		<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
			Sort
			<select name="sort" value={filters.sort} class="mt-1 w-full rounded-md border-[var(--archive-border)] bg-[var(--archive-surface)] text-[15px]">
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
			<button type="submit" class="rounded-md bg-[var(--archive-accent)] px-3 py-2 text-[13px] font-semibold text-white">Apply</button>
			<a href={archiveFilterHref('/archive', { searchableOnly: false, sort: 'updated' })} class="text-[13px] text-[var(--archive-subtle)] hover:text-[var(--archive-accent)]">Clear</a>
		</div>
	</div>
</form>
