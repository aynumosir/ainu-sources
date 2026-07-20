<script lang="ts">
	import ScanThumbnail from './ScanThumbnail.svelte';
	import { formatBytes } from '$lib/archive/format';
	import { archiveLanguageNames } from '$lib/archive/languages';
	import { formatYear } from '$lib/format';
	import type { Source } from '$lib/server/db/schema';
	import OcrBadge from './OcrBadge.svelte';
	import type { OcrCoverage } from '$lib/archive/ocr';

	type ArchiveFile = {
		fileId: string;
		revisionId: string | null;
		sourceSlug: string;
		role: string | null;
		bytes: number | null;
		mediaType: string | null;
	};

	let { item }: { item: { source: Source; file: ArchiveFile; coverage: OcrCoverage[] } } = $props();
	const source = $derived(item.source);
	const file = $derived(item.file);
	const languages = $derived(archiveLanguageNames(source.languages));
	const format = $derived(
		file.mediaType === 'application/pdf'
			? 'PDF'
			: (file.mediaType?.split('/').at(-1)?.toUpperCase() ?? null)
	);
	const metaParts = $derived(
		[format, formatBytes(file.bytes), ...languages].filter(Boolean) as string[]
	);
</script>

<div class="relative flex h-full flex-col border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3 transition hover:border-[var(--archive-gilt)]">
	<a
		href={`/archive/work/${source.slug}`}
		class="flex flex-1 flex-col before:absolute before:inset-0 before:z-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--archive-gilt)]"
		aria-label={`Read ${source.title}`}
	>
		<ScanThumbnail revisionId={file.revisionId} title={source.title} />
		<h2 class="archive-title archive-clamp-2 mt-2 text-[17px] font-semibold text-[var(--archive-text)]" title={source.title}>{source.title}</h2>
		{#if source.titleEn && source.titleEn !== source.title}
			<p class="archive-clamp-2 mt-1 text-[13px] text-[var(--archive-subtle)]" title={source.titleEn}>{source.titleEn}</p>
		{/if}
		{#if source.titleAin}
			<p class="archive-clamp-1 mt-0.5 text-[13px] text-[var(--archive-subtle)]" lang="ain-Latn" title={source.titleAin}>{source.titleAin}</p>
		{/if}
		{#if source.author}
			<p class="archive-title mt-1 truncate text-[14px] italic text-[var(--archive-text-soft)]">{source.author}</p>
		{/if}
	</a>
	<div class="mt-auto flex items-center gap-2 pt-3">
		<span class="archive-kicker bg-[var(--archive-muted)] px-1.5 py-0.5">{file.role ?? 'file'}</span>
		<span class="tnum ml-auto text-[12px] text-[var(--archive-subtle)]">{formatYear(source)}</span>
	</div>
	<p class="archive-meta mt-1.5 text-[12px] text-[var(--archive-subtle)]">
		{#each metaParts as part (part)}
			<span>{part}</span>
		{/each}
	</p>
	<div class="mt-1.5">
		<OcrBadge coverage={item.coverage} />
	</div>
</div>
