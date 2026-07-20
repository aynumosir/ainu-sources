<script lang="ts">
	import type { EditBuffer, EditHead, EditLogEntry, OcrVariant, PageText, PageStatus } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';
	import ApproveButton from './ApproveButton.svelte';
	import ConflictDialog from './ConflictDialog.svelte';
	import EditHistoryPanel from './EditHistoryPanel.svelte';
	import PageStatusChip from './PageStatusChip.svelte';
	import PageTextEditor from './PageTextEditor.svelte';
	import VariantSwitcher from './VariantSwitcher.svelte';

	type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'unavailable' | 'error';

	let {
		page,
		loadState,
		loadMessage = null,
		record = null,
		variants,
		selected,
		buffer = null,
		canEdit,
		canApprove,
		saving,
		saveError = null,
		note,
		conflict = null,
		conflictNote,
		conflictError = null,
		historyEntries,
		historyLoading,
		historyUnavailable,
		historyError = null,
		operationBusy = false,
		onselect,
		onstartedit,
		ontext,
		onnote,
		onsave,
		onapprove,
		onhistoryopen,
		onrestore,
		onrevert,
		onunapprove,
		onconflictnote,
		onusemine,
		onusetheirs
	}: {
		page: number;
		loadState: LoadState;
		loadMessage?: string | null;
		record?: PageText | null;
		variants: OcrVariant[];
		selected: string | null;
		buffer?: EditBuffer | null;
		canEdit: boolean;
		canApprove: boolean;
		saving: boolean;
		saveError?: string | null;
		note: string;
		conflict?: EditHead | null;
		conflictNote: string;
		conflictError?: string | null;
		historyEntries: EditLogEntry[];
		historyLoading: boolean;
		historyUnavailable: boolean;
		historyError?: string | null;
		operationBusy?: boolean;
		onselect: (variant: string) => void;
		onstartedit: () => void;
		ontext: (text: string) => void;
		onnote: (note: string) => void;
		onsave: () => void;
		onapprove: () => void;
		onhistoryopen: () => void;
		onrestore: (entry: EditLogEntry) => void;
		onrevert: () => void;
		onunapprove: () => void;
		onconflictnote: (note: string) => void;
		onusemine: () => void;
		onusetheirs: () => void;
	} = $props();

	let historyOpen = $state(false);
	let viewedEntry = $state<EditLogEntry | null>(null);

	const status = $derived<PageStatus>(record?.status ?? (loadState === 'empty' ? 'none' : 'machine'));
	const manual = $derived(record?.manual ?? selected === 'manual');
	const isEditableVariant = $derived(selected === 'edited' || selected === 'manual');
	const displayedText = $derived(buffer?.text ?? record?.text ?? '');
	const readOnly = $derived(!canEdit || !isEditableVariant);
	const canRevert = $derived(canEdit && (record?.status === 'edited' || record?.status === 'approved'));
	const canUnapprove = $derived(canApprove && record?.status === 'approved');

	function toggleHistory(): void {
		historyOpen = !historyOpen;
		if (historyOpen) onhistoryopen();
	}
</script>

<section class="text-column">
	<header class="kicker-row">
		<p class="archive-kicker">本文 TEXT · P.{page}</p>
		<div class="controls">
			<VariantSwitcher {variants} {selected} disabled={loadState === 'loading'} onselect={onselect} />
			<PageStatusChip {status} {manual} />
			<button type="button" class:active={historyOpen} onclick={toggleHistory}>
				<BilingualLabel ja={archiveLabels.history.ja} en={archiveLabels.history.en} />
			</button>
		</div>
	</header>

	{#if loadState === 'loading' || loadState === 'idle'}
		<div class="column-state">本文を読み込んでいます… / Loading text…</div>
	{:else if loadState === 'unavailable'}
		<div class="column-state">
			<p>本文校訂APIはまだ利用できません / Text editing is not yet available.</p>
			{#if loadMessage}<p>{loadMessage}</p>{/if}
		</div>
	{:else if loadState === 'error'}
		<div class="column-state error" role="alert">{loadMessage ?? 'Text failed to load.'}</div>
	{:else if historyOpen}
		<EditHistoryPanel
			entries={historyEntries}
			loading={historyLoading}
			unavailable={historyUnavailable}
			error={historyError}
			{canRevert}
			{canUnapprove}
			onview={(entry) => (viewedEntry = entry)}
			onrestore={(entry) => {
				onrestore(entry);
				historyOpen = false;
			}}
			onrevert={onrevert}
			onunapprove={onunapprove}
		/>
	{:else}
		{#if loadState === 'empty'}
			<p class="gap-note">このページには本文がありません / No text on this page.</p>
		{/if}
		<PageTextEditor
			{page}
			text={displayedText}
			{buffer}
			readonly={readOnly}
			empty={loadState === 'empty'}
			{canEdit}
			{saving}
			error={saveError}
			{note}
			ontext={ontext}
			onnote={onnote}
			onsave={onsave}
			onstartedit={onstartedit}
		/>
		{#if conflict}
			<ConflictDialog
				theirs={conflict}
				mine={displayedText}
				note={conflictNote}
				error={conflictError}
				onnote={onconflictnote}
				onmine={onusemine}
				ontheirs={onusetheirs}
			/>
		{/if}
		{#if canApprove && isEditableVariant}
			<div class="review-row">
				<ApproveButton editId={buffer?.dirty ? null : record?.editId ?? null} approved={status === 'approved'} busy={operationBusy} onapprove={onapprove} />
			</div>
		{/if}
	{/if}
</section>

{#if viewedEntry?.text != null}
	<div class="view-backdrop">
		<div class="view-sheet" role="dialog" aria-modal="true" aria-label="Historical OCR text">
			<header>
				<h2><BilingualLabel ja={archiveLabels.history.ja} en={archiveLabels.history.en} /> · {viewedEntry.created_at}</h2>
				<button type="button" onclick={() => (viewedEntry = null)}><BilingualLabel ja={archiveLabels.close.ja} en={archiveLabels.close.en} /></button>
			</header>
			<pre>{viewedEntry.text}</pre>
		</div>
	</div>
{/if}

<style>
	.text-column { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--archive-paper); }
	.kicker-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.55rem; border-bottom: 1px dotted var(--archive-border); padding: 0.45rem 0.7rem; }
	.controls { display: flex; min-width: 0; align-items: center; gap: 0.45rem; }
	.controls > button { border: 1px solid var(--archive-border); padding: 0.35rem 0.55rem; color: var(--archive-subtle); font-size: 12px; }
	.controls > button.active { border-color: var(--archive-gilt); color: var(--archive-gilt-text); }
	.column-state { display: grid; min-height: 18rem; flex: 1; place-content: center; gap: 0.4rem; padding: 2rem; text-align: center; color: var(--archive-subtle); }
	.column-state.error { color: var(--archive-danger); }
	.gap-note { border-bottom: 1px dotted var(--archive-border); padding: 0.45rem 0.8rem; font-size: 12px; color: var(--archive-warn); }
	.review-row { display: flex; justify-content: flex-end; border-top: 1px dotted var(--archive-border); background: var(--archive-panel); padding: 0.55rem 0.8rem; }
	.view-backdrop { position: fixed; inset: 0; z-index: 75; display: flex; align-items: center; justify-content: center; background: rgb(0 0 0 / 48%); padding: 1rem; }
	.view-sheet { width: min(48rem, 100%); max-height: calc(100svh - 2rem); overflow: auto; border: 1px solid var(--archive-border); background: var(--archive-paper); }
	.view-backdrop header { display: flex; justify-content: space-between; gap: 1rem; border-bottom: 1px dotted var(--archive-border); padding: 0.8rem 1rem; font-size: 13px; }
	.view-backdrop pre { padding: 1rem; white-space: pre-wrap; font-family: var(--font-archive-serif); font-size: 17px; line-height: 1.8; }
	@media (max-width: 899px) {
		.kicker-row { align-items: flex-start; }
		.controls { width: 100%; justify-content: space-between; }
		.view-backdrop { padding: 0; }
		.view-sheet { width: 100%; height: 100svh; max-height: none; }
	}
</style>
