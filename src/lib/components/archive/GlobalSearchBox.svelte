<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	let { q = '' }: { q?: string } = $props();
</script>

<form action="/archive/search" method="get" role="search" class="flex min-w-0 flex-1 items-center gap-2">
	<label for="archive-global-search" class="sr-only">Search archive OCR</label>
	<input
		id="archive-global-search"
		name="q"
		value={q}
		placeholder="Search OCR"
		class="h-9 w-full border border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 text-[15px] text-[var(--archive-text)] placeholder:text-[var(--archive-subtle)] focus:border-[var(--archive-gilt)] focus:ring-[var(--archive-gilt)]"
	/>
	<button
		type="submit"
		class="h-9 border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)] [--archive-label-en-color:var(--archive-paper)]"
	>
		<BilingualLabel ja={archiveLabels.search.ja} en={archiveLabels.search.en} />
	</button>
</form>
