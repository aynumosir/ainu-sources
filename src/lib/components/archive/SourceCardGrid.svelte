<script lang="ts">
	import SourceCard from './SourceCard.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
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
	<div class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-10 text-center">
		<BilingualLabel
			stacked
			ja={archiveLabels.noWorks.ja}
			en={archiveLabels.noWorks.en}
			class="text-[17px] font-semibold [--archive-label-en-size:15px]"
		/>
	</div>
{/if}
