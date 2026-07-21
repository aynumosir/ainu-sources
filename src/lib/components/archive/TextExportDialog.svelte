<script lang="ts">
	import { archiveFetch } from '$lib/archive/session.svelte';
	import { filenameFromDisposition, shapeExportFilename, type ExportFormat, type ExportVariant } from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

	let {
		revision,
		slug
	}: { revision: { id: string; revisionNo: number }; slug: string } = $props();

	let dialog: HTMLDialogElement | undefined = $state();
	let variant = $state<ExportVariant>('working');
	let format = $state<ExportFormat>('txt');
	let exportState = $state<'idle' | 'loading' | 'unavailable' | 'error'>('idle');
	let message = $state('');

	export function open(): void {
		exportState = 'idle';
		message = '';
		dialog?.showModal();
	}

	function close(): void {
		dialog?.close();
	}

	async function download(): Promise<void> {
		if (exportState === 'loading') return;
		exportState = 'loading';
		message = '';
		try {
			const params = new URLSearchParams({ format, variant });
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/export?${params}`);
			if (response.status === 404) {
				exportState = 'unavailable';
				return;
			}
			if (!response.ok) {
				exportState = 'error';
				message = await responseMessage(response);
				return;
			}
			const url = URL.createObjectURL(await response.blob());
			const anchor = document.createElement('a');
			anchor.href = url;
			anchor.download = filenameFromDisposition(response.headers.get('content-disposition'))
				?? shapeExportFilename(slug, revision.revisionNo, variant, format);
			anchor.click();
			URL.revokeObjectURL(url);
			exportState = 'idle';
			close();
		} catch (error) {
			exportState = 'error';
			message = error instanceof Error ? error.message : 'Export failed.';
		}
	}

	async function responseMessage(response: Response): Promise<string> {
		try {
			const body = await response.json() as { message?: unknown };
			return typeof body.message === 'string' ? body.message : `Export failed (${response.status}).`;
		} catch {
			return `Export failed (${response.status}).`;
		}
	}
</script>

<dialog bind:this={dialog} class="w-full max-w-lg border border-[var(--archive-border)] bg-[var(--archive-paper)] p-0 text-[var(--archive-text)] backdrop:bg-black/45">
	<form method="dialog" onsubmit={(event) => event.preventDefault()}>
		<header>
			<BilingualLabel tag="h2" ja={archiveLabels.exportText.ja} en={archiveLabels.exportText.en} class="archive-h2" />
			<button type="button" onclick={close} aria-label="Close">×</button>
		</header>
		<div class="body">
			<fieldset>
				<legend><BilingualLabel ja={archiveLabels.variant.ja} en={archiveLabels.variant.en} /></legend>
				<label><input type="radio" bind:group={variant} value="working" /> <span>edited (working text)</span></label>
				<label><input type="radio" bind:group={variant} value="machine" /> <span>machine (original OCR)</span></label>
				<label><input type="radio" bind:group={variant} value="approved" /> <span>approved only</span></label>
			</fieldset>
			<fieldset>
				<legend><BilingualLabel ja={archiveLabels.format.ja} en={archiveLabels.format.en} /></legend>
				<label><input type="radio" bind:group={format} value="txt" /> <span>Plain text (.txt)</span></label>
				<label><input type="radio" bind:group={format} value="jsonl" /> <span>Page-keyed JSONL (.jsonl)</span></label>
			</fieldset>
			<p class="audit">このダウンロードは記録されます — this download is recorded.</p>
			<p class="filename">{shapeExportFilename(slug, revision.revisionNo, variant, format)}</p>
			{#if exportState === 'unavailable'}
				<p class="notice">書き出しはまだ利用できません / Export is not yet available.</p>
			{:else if exportState === 'error'}
				<p class="notice error" role="alert">{message}</p>
			{/if}
		</div>
		<footer>
			<button type="button" onclick={close}><BilingualLabel ja={archiveLabels.cancel.ja} en={archiveLabels.cancel.en} /></button>
			<button type="button" class="primary" disabled={exportState === 'loading'} onclick={download}>
				{exportState === 'loading' ? 'Preparing…' : 'Download'}
			</button>
		</footer>
	</form>
</dialog>

<style>
	header,
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.9rem 1rem;
	}
	header { border-bottom: 1px dotted var(--archive-border); }
	footer { justify-content: flex-end; border-top: 1px solid var(--archive-border); }
	.body { display: grid; gap: 1rem; padding: 1rem; }
	fieldset { display: grid; gap: 0.4rem; }
	legend { margin-bottom: 0.35rem; font-size: 12px; font-weight: 650; color: var(--archive-subtle); }
	label { display: flex; align-items: center; gap: 0.45rem; font-size: 13px; }
	.audit,
	.filename { font-size: 12px; color: var(--archive-subtle); }
	.filename { font-family: var(--font-archive-mono); word-break: break-all; }
	.notice { border: 1px solid var(--archive-border); background: var(--archive-panel); padding: 0.6rem; font-size: 12px; }
	.error { border-color: var(--archive-danger); color: var(--archive-danger); }
	footer button { border: 1px solid var(--archive-border); padding: 0.45rem 0.8rem; font-size: 13px; }
	footer .primary { border-color: var(--archive-gilt); background: var(--archive-gilt); color: var(--archive-paper); font-weight: 650; }
</style>
