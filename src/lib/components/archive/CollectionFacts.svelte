<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import type { ArchiveStats } from '$lib/server/archive/stats';

	let { stats }: { stats: ArchiveStats } = $props();

	const fmt = (n: number) => n.toLocaleString('en-US');
	const works = $derived(stats.totals.works);
	const files = $derived(stats.totals.files);
	const pages = $derived(stats.pages.total);
	// pagesWithText counts pages on revisions that may lack a recorded page_count,
	// so the ratio can run past 100% of the recorded total; clamp the display.
	const searchablePct = $derived(
		pages > 0 ? Math.min(100, Math.round((stats.ocr.pagesWithText / pages) * 100)) : 0
	);
</script>

<ul class="archive-facts" aria-label={bilingualAriaLabel(archiveLabels.collectionFacts)}>
	<li>
		<span class="tnum archive-facts-num">{fmt(works)}</span>
		<span class="archive-facts-label"><BilingualLabel ja={archiveLabels.works.ja} en={archiveLabels.works.en} /></span>
	</li>
	<li>
		<span class="tnum archive-facts-num">{fmt(files)}</span>
		<span class="archive-facts-label"><BilingualLabel ja={archiveLabels.files.ja} en={archiveLabels.files.en} /></span>
	</li>
	<li>
		<span class="tnum archive-facts-num">{fmt(pages)}</span>
		<span class="archive-facts-label"><BilingualLabel ja={archiveLabels.pages.ja} en={archiveLabels.pages.en} /></span>
	</li>
	<li>
		<span class="tnum archive-facts-num">{searchablePct}<span class="archive-facts-pct">%</span></span>
		<span class="archive-facts-label">
			<BilingualLabel ja={archiveLabels.searchable.ja} en={archiveLabels.searchable.en} />
		</span>
	</li>
</ul>

<style>
	.archive-facts {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.4rem 1.4rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.archive-facts > li {
		display: inline-flex;
		align-items: baseline;
		gap: 0.45rem;
	}
	.archive-facts-num {
		font-family: var(--font-archive-serif);
		font-size: 22px;
		font-weight: 600;
		line-height: 1;
		color: var(--archive-text);
	}
	.archive-facts-pct {
		font-size: 0.62em;
		color: var(--archive-gilt-text);
		margin-left: 0.04em;
	}
	.archive-facts-label {
		font-variant: small-caps;
		font-size: 11px;
		letter-spacing: 0.07em;
		color: var(--archive-subtle);
	}
	.archive-facts-label :global(.archive-bilingual-label .en) {
		font-size: 1em;
	}
</style>
