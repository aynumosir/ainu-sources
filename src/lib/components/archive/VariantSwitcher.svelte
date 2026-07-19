<script lang="ts">
	import type { OcrVariant } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		variants,
		selected,
		disabled = false,
		onselect
	}: {
		variants: OcrVariant[];
		selected: string | null;
		disabled?: boolean;
		onselect: (variant: string) => void;
	} = $props();
</script>

<label class="variant-control">
	<span class="sr-only"><BilingualLabel ja={archiveLabels.variant.ja} en={archiveLabels.variant.en} /></span>
	<select
		value={selected ?? ''}
		{disabled}
		onchange={(event) => onselect(event.currentTarget.value)}
		class="h-8 min-w-36 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 text-[12px] text-[var(--archive-text)]"
	>
		{#if variants.length === 0}<option value="">no text</option>{/if}
		{#each variants as variant (variant.name)}
			<option value={variant.name}>
				{variant.label} · {variant.status === 'none' ? 'no text' : variant.status}{variant.manual ? ' · manual' : ''}
			</option>
		{/each}
	</select>
</label>

<style>
	.variant-control {
		display: inline-flex;
		min-width: 0;
	}
	select {
		max-width: min(18rem, 42vw);
	}
</style>
