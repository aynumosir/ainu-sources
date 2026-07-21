<script lang="ts">
	import type { PageStatus } from '$lib/archive/workspace';

	let { status, manual = false }: { status: PageStatus; manual?: boolean } = $props();

	const label = $derived(
		status === 'none' ? 'no text' : status === 'machine' ? 'machine' : status === 'approved' ? 'approved' : 'edited'
	);
</script>

<span class:manual class={`status-chip status-${status}`}>
	<span>{label}</span>
	{#if manual}<span class="source-tag">manual</span>{/if}
</span>

<style>
	.status-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-height: 1.5rem;
		border: 1px solid var(--archive-border);
		border-radius: 999px;
		padding: 0.1rem 0.5rem;
		color: var(--archive-subtle);
		font-family: var(--font-archive-sans);
		font-size: 11px;
		font-weight: 650;
		letter-spacing: 0.03em;
	}
	.status-edited {
		border-color: color-mix(in srgb, var(--archive-warn) 55%, var(--archive-border));
		color: var(--archive-warn);
	}
	.status-approved {
		border-color: color-mix(in srgb, var(--archive-good) 55%, var(--archive-border));
		color: var(--archive-good);
	}
	.status-none {
		border-style: dashed;
		background: transparent;
	}
	.source-tag {
		border-left: 1px solid currentColor;
		padding-left: 0.35rem;
		opacity: 0.8;
	}
</style>
