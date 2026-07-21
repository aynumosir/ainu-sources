<script lang="ts">
	import type { EditBuffer } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		page,
		text,
		buffer = null,
		readonly = false,
		empty = false,
		canEdit = false,
		saving = false,
		error = null,
		note = '',
		ontext,
		onnote,
		onsave,
		onstartedit
	}: {
		page: number;
		text: string;
		buffer?: EditBuffer | null;
		readonly?: boolean;
		empty?: boolean;
		canEdit?: boolean;
		saving?: boolean;
		error?: string | null;
		note?: string;
		ontext: (text: string) => void;
		onnote: (note: string) => void;
		onsave: () => void;
		onstartedit: () => void;
	} = $props();

	let noteOpen = $state(false);
	const dirty = $derived(buffer?.dirty ?? false);
	const placeholder = 'スキャンを見て書き起こす — transcribe this page from the scan';
</script>

<div class="editor-shell">
	{#if empty && !canEdit}
		<div class="empty-reader">
			<p class="font-semibold">このページはまだ翻刻されていません</p>
			<p>Not yet transcribed. The page image remains available in the scan pane.</p>
		</div>
	{:else}
		<textarea
			value={text}
			{readonly}
			spellcheck="false"
			aria-label={`Text for scan page ${page}`}
			{placeholder}
			oninput={(event) => ontext(event.currentTarget.value)}
		></textarea>
	{/if}

	<div class="policy-line">
		<a href="https://archive.aynu.org/transcription-policy" target="_blank" rel="noreferrer">
			<BilingualLabel ja={archiveLabels.policy.ja} en={archiveLabels.policy.en} /> ↗
		</a>
		{#if readonly && canEdit}
			<button type="button" onclick={onstartedit}>
				<BilingualLabel ja={archiveLabels.editText.ja} en={archiveLabels.editText.en} />
			</button>
		{/if}
	</div>

	{#if canEdit && !readonly}
		<footer>
			<div class="save-group">
				{#if saving}
					<span class="saving"><span class="spinner" aria-hidden="true"></span><BilingualLabel ja={archiveLabels.saving.ja} en={archiveLabels.saving.en} /></span>
				{:else if dirty}
					<span class="dirty"><span aria-hidden="true">●</span><BilingualLabel ja={archiveLabels.unsaved.ja} en={archiveLabels.unsaved.en} /></span>
				{/if}
				<button type="button" class="save" disabled={!dirty || saving} onclick={onsave}>
					{#if error}
						<BilingualLabel ja={archiveLabels.retry.ja} en={archiveLabels.retry.en} inverse={dirty && !saving} />
					{:else}
						<BilingualLabel ja={archiveLabels.save.ja} en={archiveLabels.save.en} inverse={dirty && !saving} />
					{/if}
				</button>
				<button type="button" class="note-toggle" aria-expanded={noteOpen} onclick={() => (noteOpen = !noteOpen)}>
					<BilingualLabel ja={archiveLabels.addNote.ja} en={archiveLabels.addNote.en} />
				</button>
			</div>
			{#if noteOpen}
				<label>
					<span><BilingualLabel ja={archiveLabels.note.ja} en={archiveLabels.note.en} /></span>
					<input value={note} maxlength="240" oninput={(event) => onnote(event.currentTarget.value)} />
				</label>
			{/if}
			{#if error}
				<p class="error" role="alert">{error}</p>
			{/if}
		</footer>
	{/if}
</div>

<style>
	.editor-shell {
		display: flex;
		min-height: 0;
		flex: 1;
		flex-direction: column;
	}
	textarea {
		width: 100%;
		min-height: 18rem;
		flex: 1;
		resize: none;
		border: 0;
		background: var(--archive-paper);
		padding: 1rem 1.15rem;
		color: var(--archive-text);
		font-family: var(--font-archive-serif);
		font-size: 18px;
		line-height: 1.85;
		line-break: strict;
		word-break: normal;
		white-space: pre-wrap;
	}
	textarea:focus {
		outline: 2px solid color-mix(in srgb, var(--archive-gilt) 55%, transparent);
		outline-offset: -2px;
		box-shadow: none;
	}
	textarea:read-only {
		color: var(--archive-text-soft);
	}
	.empty-reader {
		flex: 1;
		padding: 2rem;
		font-family: var(--font-archive-serif);
		font-size: 17px;
		line-height: 1.8;
		color: var(--archive-subtle);
	}
	.policy-line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		border-top: 1px dotted var(--archive-border);
		padding: 0.45rem 0.85rem;
		font-size: 12px;
	}
	.policy-line :is(a, button) {
		color: var(--archive-gilt-text);
	}
	footer {
		border-top: 1px solid var(--archive-border);
		background: var(--archive-panel);
		padding: 0.65rem 0.8rem;
	}
	.save-group {
		display: flex;
		align-items: center;
		gap: 0.55rem;
		min-height: 2rem;
	}
	.dirty,
	.saving {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		font-size: 12px;
	}
	.dirty {
		color: var(--archive-warn);
	}
	.saving {
		color: var(--archive-subtle);
	}
	.spinner {
		width: 0.75rem;
		height: 0.75rem;
		border: 1px solid var(--archive-border-strong);
		border-top-color: var(--archive-gilt);
		border-radius: 999px;
		animation: spin 700ms linear infinite;
	}
	.save {
		border: 1px solid var(--archive-gilt);
		background: var(--archive-gilt);
		padding: 0.35rem 0.7rem;
		color: var(--archive-paper);
		font-size: 13px;
		font-weight: 650;
	}
	.save:disabled {
		border-color: var(--archive-border);
		background: var(--archive-muted);
		color: var(--archive-subtle);
	}
	.note-toggle {
		color: var(--archive-gilt-text);
		font-size: 12px;
	}
	label {
		display: grid;
		grid-template-columns: auto 1fr;
		align-items: center;
		gap: 0.6rem;
		margin-top: 0.55rem;
		font-size: 12px;
		color: var(--archive-subtle);
	}
	input {
		min-width: 0;
		border: 1px solid var(--archive-border);
		background: var(--archive-paper);
		padding: 0.35rem 0.5rem;
		color: var(--archive-text);
	}
	.error {
		margin-top: 0.5rem;
		font-size: 12px;
		color: var(--archive-danger);
	}
	@keyframes spin {
		to { transform: rotate(360deg); }
	}
	@media (max-width: 899px) {
		footer {
			position: sticky;
			bottom: 0;
			z-index: 4;
		}
	}
</style>
