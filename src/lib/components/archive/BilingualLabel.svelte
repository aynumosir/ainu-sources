<script lang="ts">
	let {
		ja,
		en,
		tag = 'span',
		stacked = false,
		slash = false,
		class: className = ''
	}: { ja: string; en: string; tag?: string; stacked?: boolean; slash?: boolean; class?: string } = $props();
</script>

<svelte:element this={tag} class={`archive-bilingual-label ${className}`} class:stacked class:slash>
	<span class="ja">{ja}</span>
	{#if slash}<span class="sep" aria-hidden="true">/</span>{/if}
	<span class="en">{en}</span>
</svelte:element>

<style>
	.archive-bilingual-label {
		display: inline-flex;
		align-items: baseline;
		gap: 0.35rem;
		margin: 0;
	}
	.archive-bilingual-label.stacked {
		align-items: flex-start;
		flex-direction: column;
		gap: 0.15rem;
	}
	.ja {
		color: inherit;
		font: inherit;
	}
	.en,
	.sep {
		color: var(--archive-label-en-color, var(--archive-subtle));
		font-family: var(--font-archive-sans);
		font-size: var(--archive-label-en-size, 13px);
		font-weight: 500;
	}
</style>
