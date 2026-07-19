<script lang="ts">
	import DownloadConfirm from './DownloadConfirm.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import { formatBytes, middleEllipsis } from '$lib/archive/format';

	type FileRowData = {
		fileId: string;
		role: string | null;
		label: string | null;
		checkoutPath: string | null;
		revisionId: string | null;
		revisionNo: number | null;
		reviewStatus: string | null;
		sha256: string | null;
		bytes: number | null;
		mediaType: string | null;
	};

	let { file, sourceSlug }: { file: FileRowData; sourceSlug: string } = $props();
	let download: DownloadConfirm | undefined = $state();
	const filename = $derived(file.label ?? file.checkoutPath?.split('/').at(-1) ?? `${sourceSlug}-${file.fileId}`);
</script>

<div class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
	<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<span class="archive-kicker bg-[var(--archive-muted)] px-1.5 py-0.5">{file.role ?? 'file'}</span>
				{#if file.reviewStatus}<span class="text-[13px] text-[var(--archive-subtle)]">{file.reviewStatus}</span>{/if}
				{#if file.revisionNo}<span class="tnum text-[13px] text-[var(--archive-subtle)]">rev {file.revisionNo}</span>{/if}
			</div>
			<h3 class="mt-2 break-words text-[15px] font-semibold">{filename}</h3>
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}{#if file.mediaType} · {file.mediaType}{/if}</p>
			{#if file.sha256}
				<p class="archive-mono mt-1 text-[12px] text-[var(--archive-subtle)]" title={file.sha256}>{middleEllipsis(file.sha256)}</p>
			{/if}
		</div>
		<div class="flex gap-2">
			{#if file.revisionId}
				<a href={`/archive/read/${sourceSlug}/${file.fileId}`} aria-label={bilingualAriaLabel(archiveLabels.read)} class="border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] hover:border-[var(--archive-gilt)]">
					<BilingualLabel ja={archiveLabels.read.ja} en={archiveLabels.read.en} />
				</a>
				<button type="button" aria-label={bilingualAriaLabel(archiveLabels.download)} onclick={() => download?.open()} class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]">
					<BilingualLabel ja={archiveLabels.download.ja} en={archiveLabels.download.en} inverse />
				</button>
			{:else}
				<span class="text-[13px] text-[var(--archive-subtle)]">OCR unavailable for this file</span>
			{/if}
		</div>
	</div>
</div>

<DownloadConfirm
	bind:this={download}
	file={file.revisionId ? { revisionId: file.revisionId, filename, bytes: file.bytes } : null}
/>
