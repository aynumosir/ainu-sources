<script lang="ts">
	import type { EditHead } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		theirs,
		mine,
		note,
		error = null,
		onnote,
		onmine,
		ontheirs
	}: {
		theirs: EditHead;
		mine: string;
		note: string;
		error?: string | null;
		onnote: (note: string) => void;
		onmine: () => void;
		ontheirs: () => void;
	} = $props();

	let compareOpen = $state(false);
	const when = $derived(new Date(theirs.edited_at));
	const whenLabel = $derived(Number.isNaN(when.valueOf()) ? theirs.edited_at : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(when));
</script>

<section class="conflict" role="alert">
	<p>このページは {theirs.edited_by} によって {whenLabel} に更新されました / This page was updated by {theirs.edited_by}.</p>
	<div class="actions">
		<button type="button" onclick={() => (compareOpen = true)}><BilingualLabel ja={archiveLabels.compare.ja} en={archiveLabels.compare.en} /></button>
		<button type="button" onclick={onmine}><BilingualLabel ja={archiveLabels.useMine.ja} en={archiveLabels.useMine.en} /></button>
		<button type="button" onclick={ontheirs}><BilingualLabel ja={archiveLabels.useTheirs.ja} en={archiveLabels.useTheirs.en} /></button>
	</div>
	<label>
		<span>上書き理由 / Overwrite note (required)</span>
		<input value={note} maxlength="240" oninput={(event) => onnote(event.currentTarget.value)} />
	</label>
	{#if error}<p class="error">{error}</p>{/if}
</section>

{#if compareOpen}
	<div class="compare-backdrop" role="presentation">
		<div class="compare-sheet" role="dialog" aria-modal="true" aria-label="Compare conflicting text">
			<header>
				<h2><BilingualLabel ja={archiveLabels.compare.ja} en={archiveLabels.compare.en} /></h2>
				<button type="button" onclick={() => (compareOpen = false)}><BilingualLabel ja={archiveLabels.close.ja} en={archiveLabels.close.en} /></button>
			</header>
			<div class="comparison">
				<article><h3>相手の文 / Theirs</h3><pre>{theirs.text}</pre></article>
				<article><h3>自分の文 / Mine</h3><pre>{mine}</pre></article>
			</div>
		</div>
	</div>
{/if}

<style>
	.conflict {
		border-top: 2px solid var(--archive-danger);
		background: color-mix(in srgb, var(--archive-danger) 7%, var(--archive-paper));
		padding: 0.75rem;
		font-size: 12px;
		color: var(--archive-text);
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		margin-top: 0.6rem;
	}
	.actions button {
		border: 1px solid var(--archive-danger);
		padding: 0.35rem 0.55rem;
		color: var(--archive-danger);
	}
	label {
		display: grid;
		gap: 0.25rem;
		margin-top: 0.65rem;
		color: var(--archive-subtle);
	}
	input {
		border: 1px solid var(--archive-border);
		background: var(--archive-paper);
		padding: 0.4rem 0.5rem;
		color: var(--archive-text);
	}
	.error { margin-top: 0.4rem; color: var(--archive-danger); }
	.compare-backdrop {
		position: fixed;
		inset: 0;
		z-index: 70;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgb(0 0 0 / 48%);
		padding: 1rem;
	}
	.compare-sheet {
		width: min(72rem, 100%);
		max-height: calc(100svh - 2rem);
		overflow: auto;
		border: 1px solid var(--archive-border);
		background: var(--archive-paper);
		box-shadow: 0 20px 60px rgb(0 0 0 / 30%);
	}
	.compare-sheet header {
		display: flex;
		justify-content: space-between;
		border-bottom: 1px dotted var(--archive-border);
		padding: 0.8rem 1rem;
	}
	.comparison {
		display: grid;
		grid-template-columns: 1fr 1fr;
	}
	article { min-width: 0; padding: 1rem; }
	article + article { border-left: 1px solid var(--archive-border); }
	h3 { font-size: 12px; color: var(--archive-subtle); }
	pre {
		margin-top: 0.65rem;
		white-space: pre-wrap;
		font-family: var(--font-archive-serif);
		font-size: 17px;
		line-height: 1.75;
	}
	@media (max-width: 899px) {
		.compare-backdrop { padding: 0; }
		.compare-sheet { width: 100%; height: 100svh; max-height: none; }
		.comparison { grid-template-columns: 1fr; }
		article + article { border-top: 1px solid var(--archive-border); border-left: 0; }
	}
</style>
