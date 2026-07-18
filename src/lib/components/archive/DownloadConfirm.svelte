<script lang="ts">
	import { formatBytes } from '$lib/archive/format';

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

<dialog bind:this={dialog} class="w-full max-w-md rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-0 text-[var(--archive-text)] backdrop:bg-black/40">
	{#if file}
		<div class="p-5">
			<h2 class="text-[21px] font-semibold">Download file</h2>
			<p class="mt-3 break-words text-[15px]">{file.filename}</p>
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}</p>
			<p class="mt-4 text-[13px] leading-6 text-[var(--archive-subtle)]">
				Downloads are logged for audit and quota accounting.
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button type="button" onclick={close} class="rounded-md border border-[var(--archive-border)] px-3 py-2 text-[13px]">Cancel</button>
				<a
					href={`/api/archive/revisions/${file.revisionId}/content?disposition=attachment`}
					target="_blank"
					rel="noreferrer"
					class="rounded-md bg-[var(--archive-accent)] px-3 py-2 text-[13px] font-semibold text-white"
					onclick={close}
				>
					Download
				</a>
			</div>
		</div>
	{/if}
</dialog>
