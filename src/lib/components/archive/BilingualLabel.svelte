<script lang="ts">
	let {
		ja,
		en,
		tag = 'span',
		stacked = false,
		slash = false,
		inverse = false,
		compact = false,
		class: className = ''
	}: {
		ja: string;
		en: string;
		tag?: string;
		stacked?: boolean;
		slash?: boolean;
		inverse?: boolean;
		compact?: boolean;
		class?: string;
	} = $props();
</script>

<svelte:element
	this={tag}
	class={`archive-bilingual-label ${className}`}
	class:stacked
	class:slash
	class:inverse
	title={compact ? en : undefined}
>
	<span class="ja">{ja}</span>
	{#if !compact}
		{#if slash}<span class="sep" aria-hidden="true">/</span>{/if}
		<span class="en">{en}</span>
	{/if}
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
		font-size: var(--archive-label-en-size, 0.72em);
		font-weight: 400;
		letter-spacing: 0.02em;
		/* CJK glyphs rest on the ideographic baseline, below the alphabetic one
		   the flex row aligns to, so the Latin gloss floats high. Nudge it down;
		   serif JA drops further and widens the gap, so it overrides this. */
		transform: translateY(var(--archive-bilingual-en-shift, 0.06em));
	}
	.archive-bilingual-label.stacked .en,
	.archive-bilingual-label.stacked .sep {
		transform: none;
	}
	.archive-bilingual-label.inverse .en,
	.archive-bilingual-label.inverse .sep {
		color: inherit;
		opacity: 0.75;
	}
</style>
