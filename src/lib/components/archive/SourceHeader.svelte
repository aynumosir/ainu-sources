<script lang="ts">
	import DownloadConfirm from './DownloadConfirm.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import { formatYear } from '$lib/format';
	import type { Source } from '$lib/server/db/schema';

	type FileSummary = {
		fileId: string;
		revisionId: string | null;
		label: string | null;
		checkoutPath: string | null;
		bytes: number | null;
	};

	let { source, primaryFile }: { source: Source; primaryFile?: FileSummary | null } = $props();
	let download: DownloadConfirm | undefined = $state();
	let coverFailed = $state(false);
	const filename = $derived(primaryFile?.label ?? primaryFile?.checkoutPath?.split('/').at(-1) ?? source.slug);
	const coverSrc = $derived(
		primaryFile?.revisionId ? `/api/archive/revisions/${primaryFile.revisionId}/pages/1.webp?w=300` : null
	);
</script>

<header class="border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5">
	<a href="/archive" class="text-[13px] text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">← Library</a>
	<div class="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
		<div class="flex min-w-0 gap-4">
			{#if coverSrc && !coverFailed}
				<div class="hidden aspect-[4/5] w-20 shrink-0 overflow-hidden border border-[var(--archive-border)] bg-[var(--archive-bg)] sm:block">
					<img
						src={coverSrc}
						alt=""
						class="h-full w-full object-cover"
						loading="lazy"
						onerror={() => {
							coverFailed = true;
						}}
					/>
				</div>
			{/if}
			<div class="min-w-0">
				<p class="tnum text-[15px] text-[var(--archive-subtle)]">{formatYear(source)}</p>
				<h1 class="archive-h1 mt-1">{source.title}</h1>
				{#if source.titleEn && source.titleEn !== source.title}
					<p class="mt-1 text-[17px] text-[var(--archive-subtle)]">{source.titleEn}</p>
				{/if}
				{#if source.titleAin}
					<p class="mt-0.5 text-[15px] text-[var(--archive-subtle)]" lang="ain-Latn">{source.titleAin}</p>
				{/if}
				{#if source.author}<p class="mt-2 text-[15px]">{source.author}</p>{/if}
				<p class="mt-2 text-[13px] text-[var(--archive-subtle)]">
					{source.dialect ?? 'Dialect unknown'}{#if source.holdingInstitution} · {source.holdingInstitution}{/if}
				</p>
			</div>
		</div>
		<div class="flex flex-wrap gap-2">
			{#if primaryFile?.fileId}
				<a href={`/archive/read/${source.slug}/${primaryFile.fileId}`} aria-label={bilingualAriaLabel(archiveLabels.read)} class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)] hover:bg-[var(--archive-gilt-text)]">
					<BilingualLabel ja={archiveLabels.read.ja} en={archiveLabels.read.en} inverse />
				</a>
			{/if}
			{#if primaryFile?.revisionId}
				<button
					type="button"
					aria-label={bilingualAriaLabel(archiveLabels.download)}
					onclick={() => download?.open()}
					class="border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] font-semibold hover:border-[var(--archive-gilt)]"
				>
					<BilingualLabel ja={archiveLabels.download.ja} en={archiveLabels.download.en} />
				</button>
			{/if}
		</div>
	</div>
</header>

<DownloadConfirm
	bind:this={download}
	file={primaryFile?.revisionId ? { revisionId: primaryFile.revisionId, filename, bytes: primaryFile.bytes } : null}
/>
