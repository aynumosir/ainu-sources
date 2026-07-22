<script lang="ts">
	import ScanThumbnail from './ScanThumbnail.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { formatBytes } from '$lib/archive/format';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import {
		chooseLibraryOcrVariant,
		ocrEngineLabel,
		ocrSealFor,
		summarizeOcrCoverage
	} from '$lib/archive/ocr';
	import { formatYear } from '$lib/format';
	import type { ArchiveLibraryItem } from '$lib/archive/library-item';

	let { items }: { items: ArchiveLibraryItem[] } = $props();

	function engineOf(item: ArchiveLibraryItem): string | null {
		const coverage = item.coverage ?? [];
		const variant = chooseLibraryOcrVariant(coverage);
		const row = coverage.find((c) => c.variant === variant);
		return row ? ocrEngineLabel(row) : null;
	}
	function summaryOf(item: ArchiveLibraryItem) {
		return summarizeOcrCoverage(item.coverage ?? []);
	}
</script>

{#if items.length}
	<ul class="archive-list">
		{#each items as item (item.file.fileId)}
			{@const source = item.source}
			{@const file = item.file}
			{@const summary = summaryOf(item)}
			{@const seal = ocrSealFor(summary.state)}
			{@const engine = engineOf(item)}
			<li class="archive-list-row">
				<a href={`/archive/work/${source.slug}`} class="archive-list-link" aria-label={`Read ${source.title}`}>
					<span class="archive-list-thumb">
						<ScanThumbnail revisionId={file.revisionId} title={source.title} />
					</span>
					<span class="archive-list-titles">
						<span class="archive-title archive-clamp-1 text-[15px] font-semibold text-[var(--archive-text)]">{source.title}</span>
						{#if source.titleEn && source.titleEn !== source.title}
							<span class="archive-clamp-1 text-[12px] text-[var(--archive-subtle)]">{source.titleEn}</span>
						{/if}
					</span>
					<span class="archive-list-author archive-title">{source.author ?? ''}</span>
					<span class="archive-list-year tnum">{formatYear(source)}</span>
					<span class="archive-list-size tnum">{formatBytes(file.bytes)}</span>
					<span class={`archive-list-seal ${seal.className}`} role="img" aria-label={summary.label}>{seal.glyph}</span>
					<span class="archive-list-text">
						{#if engine}<span class="archive-card-engine">text: {engine}</span>{:else}<span class="archive-card-notext">no text</span>{/if}
					</span>
				</a>
				<a
					href={`/sources/${encodeURIComponent(source.slug)}`}
					class="archive-list-catalogue"
					aria-label="View in catalogue"
				>↗</a>
			</li>
		{/each}
	</ul>
{:else}
	<div class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-10 text-center">
		<BilingualLabel
			stacked
			ja={archiveLabels.noWorks.ja}
			en={archiveLabels.noWorks.en}
			class="text-[17px] font-semibold"
		/>
	</div>
{/if}

<style>
	.archive-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--archive-border);
	}
	.archive-list-row {
		position: relative;
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr) auto auto auto auto auto;
		align-items: center;
		column-gap: 0.9rem;
		border-bottom: 1px solid var(--archive-border);
		transition: background-color 0.15s ease;
	}
	.archive-list-row::before {
		content: '';
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--archive-gilt);
		transform: scaleY(0);
		transition: transform 0.15s ease;
	}
	.archive-list-row:hover {
		background: var(--archive-panel);
	}
	.archive-list-row:hover::before {
		transform: scaleY(1);
	}
	.archive-list-link {
		display: grid;
		grid-template-columns: subgrid;
		grid-column: 1 / -1;
		align-items: center;
		column-gap: 0.9rem;
		padding: 0.5rem 0.85rem;
	}
	.archive-list-link:focus-visible {
		outline: 2px solid var(--archive-gilt);
		outline-offset: -2px;
	}
	.archive-list-thumb {
		width: 30px;
	}
	.archive-list-titles {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.archive-list-author {
		font-size: 13px;
		font-style: italic;
		color: var(--archive-text-soft);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.archive-list-year,
	.archive-list-size {
		font-size: 12px;
		color: var(--archive-subtle);
		white-space: nowrap;
	}
	.archive-list-seal {
		font-size: 12px;
		line-height: 1;
	}
	.archive-list-seal.is-good {
		color: var(--archive-good);
	}
	.archive-list-seal.is-warn {
		color: var(--archive-warn);
	}
	.archive-list-seal.is-none {
		color: var(--archive-border-strong);
	}
	.archive-list-text {
		font-size: 11px;
		white-space: nowrap;
	}
	.archive-list-catalogue {
		position: absolute;
		right: 0.5rem;
		top: 0.5rem;
		z-index: 2;
		font-size: 12px;
		color: var(--archive-gilt-text);
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}
	.archive-list-row:hover .archive-list-catalogue,
	.archive-list-catalogue:focus-visible {
		opacity: 1;
		pointer-events: auto;
	}
	@media (hover: none) {
		.archive-list-catalogue {
			opacity: 1;
			pointer-events: auto;
		}
	}
	@media (max-width: 760px) {
		.archive-list-row {
			grid-template-columns: 30px minmax(0, 1fr) auto auto;
		}
		.archive-list-author,
		.archive-list-size,
		.archive-list-text {
			display: none;
		}
	}
</style>
