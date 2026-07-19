<script lang="ts">
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		editId,
		approved = false,
		busy = false,
		onapprove
	}: { editId: string | null; approved?: boolean; busy?: boolean; onapprove: () => void } = $props();

	let confirming = $state(false);
</script>

{#if confirming}
	<div class="confirm">
		<span>このページの本文を承認しますか？ / Approve this page’s text?</span>
		<button type="button" disabled={busy} onclick={onapprove}>
			<BilingualLabel ja={archiveLabels.approve.ja} en={archiveLabels.approve.en} />
		</button>
		<button type="button" onclick={() => (confirming = false)}>
			<BilingualLabel ja={archiveLabels.cancel.ja} en={archiveLabels.cancel.en} />
		</button>
	</div>
{:else}
	<button type="button" class="approve" disabled={!editId || approved || busy} onclick={() => (confirming = true)}>
		<BilingualLabel ja={archiveLabels.approve.ja} en={archiveLabels.approve.en} />
	</button>
{/if}

<style>
	.approve,
	.confirm button {
		border: 1px solid var(--archive-good);
		padding: 0.35rem 0.65rem;
		color: var(--archive-good);
		font-size: 12px;
	}
	.approve:disabled {
		border-color: var(--archive-border);
		color: var(--archive-subtle);
		opacity: 0.65;
	}
	.confirm {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.5rem;
		font-size: 12px;
		color: var(--archive-subtle);
	}
</style>
