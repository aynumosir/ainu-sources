<script lang="ts">
	import { fly } from 'svelte/transition';
	import SourceCard from './SourceCard.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import { reveal } from '$lib/archive/reveal.svelte';
	import type { ArchiveLibraryItem } from '$lib/archive/library-item';

	let { items }: { items: ArchiveLibraryItem[] } = $props();
</script>

{#if items.length}
	<div class="archive-card-grid">
		{#each items as item, i (item.file.fileId)}
			<div class="h-full" use:reveal={Math.min(i, 8) * 45} out:fly={{ y: 8, duration: 180 }}>
				<SourceCard {item} index={i} />
			</div>
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

<style>
	.archive-card-grid {
		display: grid;
		gap: 1rem;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	}
</style>
