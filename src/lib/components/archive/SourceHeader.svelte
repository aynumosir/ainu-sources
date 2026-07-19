<script lang="ts">
	import DownloadConfirm from './DownloadConfirm.svelte';
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

<header class="rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-5">
	<a href="/archive" class="text-[13px] text-[var(--archive-subtle)] hover:text-[var(--archive-accent)]">← Library</a>
	<div class="mt-3 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
		<div class="flex min-w-0 gap-4">
			{#if coverSrc && !coverFailed}
				<div class="hidden aspect-[4/5] w-20 shrink-0 overflow-hidden rounded-md border border-[var(--archive-border)] bg-[var(--archive-muted)] sm:block">
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
				<h1 class="archive-title mt-1 text-[27px] font-semibold">{source.title}</h1>
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
				<a href={`/archive/read/${source.slug}/${primaryFile.fileId}`} class="rounded-md bg-[var(--archive-accent)] px-3 py-2 text-[13px] font-semibold text-white">Read</a>
			{/if}
			{#if primaryFile?.revisionId}
				<button
					type="button"
					onclick={() => download?.open()}
					class="rounded-md border border-[var(--archive-border)] px-3 py-2 text-[13px] font-semibold"
				>
					Download
				</button>
			{/if}
		</div>
	</div>
</header>

<DownloadConfirm
	bind:this={download}
	file={primaryFile?.revisionId ? { revisionId: primaryFile.revisionId, filename, bytes: primaryFile.bytes } : null}
/>
