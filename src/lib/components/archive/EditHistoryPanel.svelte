<script lang="ts">
	import type { EditLogEntry } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		entries,
		loading = false,
		unavailable = false,
		error = null,
		canRevert = false,
		canUnapprove = false,
		onview,
		onrestore,
		onrevert,
		onunapprove
	}: {
		entries: EditLogEntry[];
		loading?: boolean;
		unavailable?: boolean;
		error?: string | null;
		canRevert?: boolean;
		canUnapprove?: boolean;
		onview: (entry: EditLogEntry) => void;
		onrestore: (entry: EditLogEntry) => void;
		onrevert: () => void;
		onunapprove: () => void;
	} = $props();

	let confirmRevert = $state(false);
	let confirmUnapprove = $state(false);

	function eventLabel(kind: EditLogEntry['kind']): string {
		return kind === 'edit'
			? 'edited'
			: kind === 'approve'
				? 'approved'
				: kind === 'unapprove'
					? 'approval withdrawn'
					: kind === 'demote'
						? 'approval demoted'
						: 'reverted to machine';
	}

	function dateLabel(value: string): string {
		const date = new Date(value);
		return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
	}
</script>

<section class="history-panel">
	<div class="history-actions">
		{#if canRevert}
			{#if confirmRevert}
				<span>機械OCRに戻しますか？ / Revert this page?</span>
				<button type="button" onclick={onrevert}><BilingualLabel ja={archiveLabels.revertMachine.ja} en={archiveLabels.revertMachine.en} /></button>
				<button type="button" onclick={() => (confirmRevert = false)}><BilingualLabel ja={archiveLabels.cancel.ja} en={archiveLabels.cancel.en} /></button>
			{:else}
				<button type="button" onclick={() => (confirmRevert = true)}><BilingualLabel ja={archiveLabels.revertMachine.ja} en={archiveLabels.revertMachine.en} /></button>
			{/if}
		{/if}
		{#if canUnapprove}
			{#if confirmUnapprove}
				<span>承認を取り消しますか？ / Withdraw approval?</span>
				<button type="button" onclick={onunapprove}><BilingualLabel ja={archiveLabels.unapprove.ja} en={archiveLabels.unapprove.en} /></button>
				<button type="button" onclick={() => (confirmUnapprove = false)}><BilingualLabel ja={archiveLabels.cancel.ja} en={archiveLabels.cancel.en} /></button>
			{:else}
				<button type="button" onclick={() => (confirmUnapprove = true)}><BilingualLabel ja={archiveLabels.unapprove.ja} en={archiveLabels.unapprove.en} /></button>
			{/if}
		{/if}
	</div>

	{#if loading}
		<p class="state">履歴を読み込んでいます… / Loading history…</p>
	{:else if unavailable}
		<p class="state">履歴はまだ利用できません / History is not yet available.</p>
	{:else if error}
		<p class="state error" role="alert">{error}</p>
	{:else if entries.length === 0}
		<p class="state">編集履歴はありません / No edit history for this page.</p>
	{:else}
		<ol>
			{#each entries as entry, index (`${entry.kind}:${entry.edit_id ?? entry.created_at}:${index}`)}
				<li class:event-approve={entry.kind === 'approve'} class:event-edit={entry.kind === 'edit'}>
					<div class="event-mark" aria-hidden="true">{entry.kind === 'approve' ? '✓' : entry.kind === 'revert' ? '↩' : '●'}</div>
					<div class="event-body">
						<p><strong>{eventLabel(entry.kind)}</strong> <span>{dateLabel(entry.created_at)} · {entry.actor}</span></p>
						{#if entry.note}<p class="note">“{entry.note}”</p>{/if}
					</div>
					{#if entry.kind === 'edit' && entry.text != null}
						<div class="entry-actions">
							<button type="button" onclick={() => onview(entry)}><BilingualLabel ja={archiveLabels.view.ja} en={archiveLabels.view.en} /></button>
							<button type="button" onclick={() => onrestore(entry)}><BilingualLabel ja={archiveLabels.restore.ja} en={archiveLabels.restore.en} /></button>
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.history-panel {
		min-height: 0;
		flex: 1;
		overflow: auto;
		padding: 0.9rem 1rem;
	}
	.history-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		border-bottom: 1px dotted var(--archive-border);
		padding-bottom: 0.75rem;
		font-size: 12px;
		color: var(--archive-subtle);
	}
	button {
		color: var(--archive-gilt-text);
	}
	ol {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	li {
		display: grid;
		grid-template-columns: 1rem minmax(0, 1fr) auto;
		gap: 0.55rem;
		border-bottom: 1px dotted var(--archive-border);
		padding: 0.85rem 0;
		font-size: 12px;
	}
	.event-mark {
		color: var(--archive-subtle);
	}
	.event-edit .event-mark { color: var(--archive-warn); }
	.event-approve .event-mark { color: var(--archive-good); }
	.event-body span,
	.note {
		color: var(--archive-subtle);
	}
	.note { margin-top: 0.25rem; }
	.entry-actions {
		display: flex;
		gap: 0.5rem;
	}
	.state {
		padding: 2rem 0;
		text-align: center;
		color: var(--archive-subtle);
	}
	.error { color: var(--archive-danger); }
</style>
