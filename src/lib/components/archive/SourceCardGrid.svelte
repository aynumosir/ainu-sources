<script lang="ts">
	import SourceCard from './SourceCard.svelte';
	import type { Source } from '$lib/server/db/schema';

	type Item = {
		source: Source;
		file: {
			fileId: string;
			revisionId: string | null;
			sourceSlug: string;
			role: string | null;
			bytes: number | null;
			mediaType: string | null;
		};
		coverage?: null;
	};

	let { items }: { items: Item[] } = $props();
</script>

{#if items.length}
	<div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
		{#each items as item (item.file.fileId)}
			<SourceCard {item} />
		{/each}
	</div>
{:else}
	<div class="rounded-lg border border-dashed border-[var(--archive-border)] bg-[var(--archive-surface)] p-10 text-center">
		<p class="text-[17px] font-semibold">該当する資料がありません</p>
		<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">no works match these filters</p>
	</div>
{/if}
