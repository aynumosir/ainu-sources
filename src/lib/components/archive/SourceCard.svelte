<script lang="ts">
	import ScanThumbnail from './ScanThumbnail.svelte';
	import OcrBadge from './OcrBadge.svelte';
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

<a
	href={`/archive/sources/${source.slug}`}
	class="block rounded-lg border border-[var(--archive-border)] bg-[var(--archive-surface)] p-3 transition hover:border-[var(--archive-accent)]"
>
	<ScanThumbnail revisionId={file.revisionId} title={source.title} />
	<div class="mt-3 flex items-center gap-2">
		<span class="rounded bg-[var(--archive-muted)] px-1.5 py-0.5 text-[12px] text-[var(--archive-subtle)]">{file.role ?? 'file'}</span>
		<OcrBadge coverage={item.coverage} />
	</div>
	<h2 class="archive-title mt-2 text-[16px] font-semibold text-[var(--archive-text)]">{source.title}</h2>
	{#if source.author}
		<p class="mt-1 truncate text-[13px] text-[var(--archive-subtle)]">{source.author}</p>
	{/if}
	<p class="mt-2 text-[13px] text-[var(--archive-subtle)]">
		<span class="tnum">{formatYear(source)}</span>
		{#if source.dialect}<span> · {source.dialect}</span>{/if}
	</p>
	<p class="mt-1 text-[12px] text-[var(--archive-subtle)]">{formatBytes(file.bytes)}{#if file.mediaType} · {file.mediaType}{/if}</p>
</a>
