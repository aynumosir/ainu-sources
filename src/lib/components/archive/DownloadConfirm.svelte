<script lang="ts">
	import { formatBytes } from '$lib/archive/format';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	type DownloadFile = {
		revisionId: string;
		filename: string;
		bytes: number | null;
	};

	let { file = null }: { file?: DownloadFile | null } = $props();
	let dialog: HTMLDialogElement | undefined = $state();

	export function open(): void {
		dialog?.showModal();
	}

	function close(): void {
		dialog?.close();
	}
</script>

<dialog bind:this={dialog} class="w-full max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-0 text-[var(--archive-text)] backdrop:bg-black/40">
	{#if file}
		<div class="p-5">
			<BilingualLabel
				tag="h2"
				ja={archiveLabels.download.ja}
				en={archiveLabels.download.en}
				class="text-[21px] font-semibold"
			/>
			<p class="mt-3 break-words text-[15px]">{file.filename}</p>
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}</p>
			<p class="mt-4 text-[13px] leading-6 text-[var(--archive-subtle)]">
				Downloads are logged for audit and quota accounting.
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button type="button" onclick={close} class="border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] hover:border-[var(--archive-gilt)]">Cancel</button>
				<a
					href={`/api/archive/revisions/${file.revisionId}/content?disposition=attachment`}
					target="_blank"
					rel="noreferrer"
					aria-label={bilingualAriaLabel(archiveLabels.download)}
					class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]"
					onclick={close}
				>
					<BilingualLabel ja={archiveLabels.download.ja} en={archiveLabels.download.en} inverse />
				</a>
			</div>
		</div>
	{/if}
</dialog>
