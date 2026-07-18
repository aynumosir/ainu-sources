<script lang="ts">
	import DownloadConfirm from './DownloadConfirm.svelte';
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

<div class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-4">
	<div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<span class="rounded bg-[var(--archive-muted)] px-1.5 py-0.5 text-[12px]">{file.role ?? 'file'}</span>
				{#if file.reviewStatus}<span class="text-[12px] text-[var(--archive-subtle)]">{file.reviewStatus}</span>{/if}
				{#if file.revisionNo}<span class="tnum text-[12px] text-[var(--archive-subtle)]">rev {file.revisionNo}</span>{/if}
			</div>
			<h3 class="mt-2 break-words text-[15px] font-semibold">{filename}</h3>
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}{#if file.mediaType} · {file.mediaType}{/if}</p>
			{#if file.sha256}
				<p class="archive-mono mt-1 text-[12px] text-[var(--archive-subtle)]" title={file.sha256}>{middleEllipsis(file.sha256)}</p>
			{/if}
		</div>
		<div class="flex gap-2">
			{#if file.revisionId}
				<a href={`/archive/read/${sourceSlug}/${file.fileId}`} class="rounded-md border border-[var(--archive-border)] px-3 py-2 text-[13px]">Read</a>
				<button type="button" onclick={() => download?.open()} class="rounded-md bg-[var(--archive-accent)] px-3 py-2 text-[13px] font-semibold text-white">Download</button>
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
