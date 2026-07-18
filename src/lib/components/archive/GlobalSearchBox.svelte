<script lang="ts">
	let { q = '' }: { q?: string } = $props();
</script>

<form action="/archive/search" method="get" role="search" class="flex min-w-0 flex-1 items-center gap-2">
	<label for="archive-global-search" class="sr-only">Search archive OCR</label>
	<input
		id="archive-global-search"
		name="q"
		value={q}
		placeholder="Search OCR"
		class="h-9 w-full rounded-md border border-[var(--archive-border)] bg-[var(--archive-surface)] px-3 text-[15px] text-[var(--archive-text)] placeholder:text-[var(--archive-subtle)] focus:border-[var(--archive-accent)] focus:ring-[var(--archive-accent)]"
	/>
	<button
		type="submit"
		class="h-9 rounded-md bg-[var(--archive-accent)] px-3 text-[13px] font-semibold text-white hover:opacity-90"
	>
		Search
	</button>
</form>
