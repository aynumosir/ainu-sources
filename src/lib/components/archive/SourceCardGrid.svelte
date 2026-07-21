<script lang="ts">
	import SourceCard from './SourceCard.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import type { ArchiveLibraryItem } from '$lib/archive/library-item';

	let { items }: { items: ArchiveLibraryItem[] } = $props();
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
			class="text-[17px] font-semibold"
		/>
	</div>
{/if}
