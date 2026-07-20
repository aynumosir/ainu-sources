<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, type ArchiveLabelKey } from '$lib/archive/bilingual-labels';

	let { title = '', label = null }: { title?: string; label?: { ja: string; en: string } | null } = $props();

	const titleLabels: Record<string, ArchiveLabelKey> = {
		Upload: 'upload',
		Uploads: 'uploads',
		Review: 'review',
		'Review detail': 'reviewDetail',
		Reader: 'reader'
	};

	function labelFor(value: string): { ja: string; en: string } | null {
		const key = titleLabels[value];
		return key ? archiveLabels[key] : null;
	}

	const resolvedLabel = $derived(label ?? labelFor(title));
</script>

<section class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-8">
	{#if resolvedLabel}
		<BilingualLabel
			tag="h1"
			stacked
			ja={resolvedLabel.ja}
			en={resolvedLabel.en}
			class="archive-h1"
		/>
	{:else}
		<h1 class="archive-h1">{title}</h1>
	{/if}
	<p class="mt-3 text-[15px] text-[var(--archive-subtle)]">
		<BilingualLabel ja={archiveLabels.underConstruction.ja} en={archiveLabels.underConstruction.en} />
	</p>
</section>
