<script lang="ts">
	import ScanThumbnail from './ScanThumbnail.svelte';
	import OcrBadge from './OcrBadge.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import { formatBytes } from '$lib/archive/format';
	import { formatYear } from '$lib/format';
	import type { Source } from '$lib/server/db/schema';

	type ArchiveFile = {
		fileId: string;
		revisionId: string | null;
		sourceSlug: string;
		role: string | null;
		bytes: number | null;
		mediaType: string | null;
	};

	let { item }: { item: { source: Source; file: ArchiveFile; coverage?: null } } = $props();
	const source = $derived(item.source);
	const file = $derived(item.file);
</script>

<div class="relative border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3 transition hover:border-[var(--archive-gilt)]">
	<a
		href={`/archive/read/${source.slug}/${file.fileId}`}
		class="block before:absolute before:inset-0 before:z-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--archive-gilt)]"
		aria-label={`Read ${source.title}`}
	>
		<ScanThumbnail revisionId={file.revisionId} title={source.title} />
		<h2 class="archive-title mt-2 text-[17px] font-semibold text-[var(--archive-text)]">{source.title}</h2>
		{#if source.titleEn && source.titleEn !== source.title}
			<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{source.titleEn}</p>
		{/if}
		{#if source.titleAin}
			<p class="mt-0.5 text-[13px] text-[var(--archive-subtle)]" lang="ain-Latn">{source.titleAin}</p>
		{/if}
		{#if source.author}
			<p class="mt-1 truncate text-[13px] text-[var(--archive-subtle)]">{source.author}</p>
		{/if}
	</a>
	<div class="mt-3 flex items-center gap-2">
		<span class="archive-kicker bg-[var(--archive-muted)] px-1.5 py-0.5">{file.role ?? 'file'}</span>
		<OcrBadge coverage={item.coverage} />
	</div>
	<p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-[var(--archive-subtle)]">
		<span class="tnum">{formatYear(source)}</span>
		{#if source.dialect}<span>{source.dialect}</span>{/if}
		<a
			href={`/archive/sources/${source.slug}`}
			class="relative z-10 font-medium text-[var(--archive-gilt-text)] underline decoration-dotted underline-offset-4 hover:text-[var(--archive-gilt)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--archive-gilt)]"
		>
			{archiveLabels.about.ja} / {archiveLabels.about.en.toLowerCase()}
		</a>
	</p>
	<p class="mt-1 text-[13px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}{#if file.mediaType} · {file.mediaType}{/if}</p>
</div>
