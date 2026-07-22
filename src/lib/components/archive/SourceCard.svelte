<script lang="ts">
	import ScanThumbnail from './ScanThumbnail.svelte';
	import { formatBytes } from '$lib/archive/format';
	import { archiveLanguageNames } from '$lib/archive/languages';
	import { formatYear } from '$lib/format';
	import {
		chooseDefaultOcrVariant,
		ocrEngineLabel,
		summarizeOcrCoverage
	} from '$lib/archive/ocr';
	import type { ArchiveLibraryItem } from '$lib/archive/library-item';

	let { item, index = 0 }: { item: ArchiveLibraryItem; index?: number } = $props();
	const source = $derived(item.source);
	const file = $derived(item.file);
	const coverage = $derived(item.coverage ?? []);
	const languages = $derived(archiveLanguageNames(source.languages));

	const summary = $derived(summarizeOcrCoverage(coverage));
	const shownVariant = $derived(chooseDefaultOcrVariant(coverage));
	const shownRow = $derived(coverage.find((c) => c.variant === shownVariant));
	const engine = $derived(shownRow ? ocrEngineLabel(shownRow) : null);

	const seal = $derived(
		summary.state === 'available' ? '●' : summary.state === 'unreadable' ? '◐' : '○'
	);
	const sealClass = $derived(
		summary.state === 'available'
			? 'is-good'
			: summary.state === 'unreadable'
				? 'is-warn'
				: 'is-none'
	);

	const metaParts = $derived(
		[
			source.author,
			formatYear(source),
			file.pageCount ? `${file.pageCount}p` : null,
			formatBytes(file.bytes)
		].filter((part): part is string => !!part)
	);
</script>

<article class="archive-card" data-reveal-index={index}>
	<a href={`/archive/work/${source.slug}`} class="archive-card-link" aria-label={`Read ${source.title}`}>
		<div class="archive-card-thumb">
			<ScanThumbnail revisionId={file.revisionId} title={source.title} />
		</div>
		<div class="archive-card-body">
			<span class={`archive-card-seal ${sealClass}`} aria-hidden="true">{seal}</span>
			<h2 class="archive-title archive-clamp-2 text-[17px] font-semibold leading-snug text-[var(--archive-text)]">
				{source.title}
			</h2>
			{#if source.titleEn && source.titleEn !== source.title}
				<p class="archive-clamp-1 mt-0.5 text-[13px] text-[var(--archive-subtle)]">{source.titleEn}</p>
			{/if}
			{#if source.titleAin}
				<p class="archive-clamp-1 mt-0.5 text-[13px] text-[var(--archive-subtle)]" lang="ain-Latn">{source.titleAin}</p>
			{/if}
			<p class="archive-card-meta tnum mt-1.5 text-[12.5px] text-[var(--archive-text-soft)]">
				{#each metaParts as part, i (i)}
					{#if i > 0}<span class="archive-card-dot" aria-hidden="true">·</span>{/if}<span>{part}</span>
				{/each}
			</p>
			<p class="archive-card-tags mt-1.5 text-[11.5px]">
				{#if engine}
					<span class="archive-card-engine">text: {engine}</span>
				{:else}
					<span class="archive-card-notext">no text</span>
				{/if}
				{#each languages as language (language)}
					<span class="archive-card-lang">{language}</span>
				{/each}
			</p>
		</div>
	</a>
	<a
		href={`/sources/${encodeURIComponent(source.slug)}`}
		class="archive-card-catalogue"
		aria-label="View in catalogue"
	>catalogue ↗</a>
</article>

<style>
	.archive-card {
		position: relative;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--archive-border);
		background: var(--archive-paper);
		transition: border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
	}
	.archive-card:hover {
		border-color: var(--archive-border-strong);
		box-shadow: 0 6px 22px -14px rgba(31, 27, 22, 0.55);
		transform: translateY(-2px);
	}
	.archive-card-link {
		display: flex;
		gap: 0.85rem;
		padding: 0.85rem;
	}
	.archive-card-link::before {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 0;
	}
	.archive-card-link:focus-visible {
		outline: 2px solid var(--archive-gilt);
		outline-offset: -2px;
	}
	.archive-card-thumb {
		flex: 0 0 56px;
		position: relative;
		z-index: 1;
	}
	.archive-card-body {
		position: relative;
		z-index: 1;
		min-width: 0;
		flex: 1;
	}
	.archive-card-seal {
		position: absolute;
		top: 0;
		right: 0;
		font-size: 13px;
		line-height: 1;
	}
	.archive-card-seal.is-good {
		color: var(--archive-good);
	}
	.archive-card-seal.is-warn {
		color: var(--archive-warn);
	}
	.archive-card-seal.is-none {
		color: var(--archive-border-strong);
	}
	.archive-card h2 {
		padding-right: 1.1rem;
		background-image: linear-gradient(var(--archive-gilt), var(--archive-gilt));
		background-repeat: no-repeat;
		background-position: 0 100%;
		background-size: 0% 1.5px;
		transition: background-size 0.28s ease;
	}
	.archive-card:hover h2 {
		background-size: 100% 1.5px;
	}
	.archive-card-meta {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.15rem 0.4rem;
	}
	.archive-card-meta > span {
		white-space: nowrap;
	}
	.archive-card-dot {
		color: var(--archive-faint-text);
	}
	.archive-card-tags {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.4rem;
	}
	.archive-card-engine {
		font-family: var(--font-archive-mono);
		color: var(--archive-gilt-text);
	}
	.archive-card-notext {
		font-family: var(--font-archive-mono);
		color: var(--archive-subtle);
	}
	.archive-card-lang {
		font-variant: small-caps;
		letter-spacing: 0.04em;
		color: var(--archive-subtle);
	}
	.archive-card-catalogue {
		position: relative;
		z-index: 2;
		align-self: flex-end;
		margin: 0 0.85rem 0.7rem;
		font-size: 11px;
		color: var(--archive-gilt-text);
		text-decoration: underline;
		text-decoration-style: dotted;
		text-underline-offset: 2px;
	}
	.archive-card-catalogue:hover {
		color: var(--archive-gilt);
	}
</style>
