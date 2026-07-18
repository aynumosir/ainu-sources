<script lang="ts">
	import FilterBar from '$lib/components/archive/FilterBar.svelte';
	import SourceCardGrid from '$lib/components/archive/SourceCardGrid.svelte';
	import PaginationCursor from '$lib/components/archive/PaginationCursor.svelte';

	let { data } = $props();
</script>

<div class="space-y-5">
	<div class="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
		<div>
			<h1 class="text-[27px] font-semibold">Library</h1>
			<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Approved current files available in the restricted archive.</p>
		</div>
	</div>
	<FilterBar filters={data.filters} />
	{#if data.filters.searchableOnly}
		<p class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-3 text-[13px] text-[var(--archive-subtle)]">
			OCR coverage data is not available in phase 1, so searchable-only cannot be verified from this list.
		</p>
	{/if}
	<SourceCardGrid items={data.items} />
	<PaginationCursor nextCursor={data.nextCursor} params={data.params} />
</div>
