<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { formatBytes } from '$lib/archive/format';

	let { data } = $props();
	const stats = $derived(data.stats);

	const number = (value: number | null | undefined) =>
		value == null ? '—' : new Intl.NumberFormat('en').format(value);

	const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

	const pagesWithText = $derived(stats?.ocr?.pagesWithText ?? 0);
	const pagesScanned = $derived(stats?.pages?.total ?? 0);
	const pagesWithoutText = $derived(Math.max(0, pagesScanned - pagesWithText));
	const eraMax = $derived(Math.max(1, ...(stats?.distribution?.era?.values ?? []).map((v) => v.count)));
</script>

<ArchiveHead title="統計 Statistics" />

{#if stats}
	<section class="w-full max-w-3xl">
		<BilingualLabel tag="h1" stacked ja="統計" en="Statistics" class="archive-h1" />
		<p class="mt-2 text-[15px] text-[var(--archive-subtle)]">
			What this archive holds, and how much of it is searchable. Figures carry their denominators;
			where a value was never recorded, it says so.
		</p>

		<!-- Headline -->
		<div class="mt-8 grid grid-cols-2 gap-px border border-[var(--archive-border)] bg-[var(--archive-border)] sm:grid-cols-4">
			{#each [['works', stats.totals.works, '資料 Works'], ['files', stats.totals.files, 'ファイル Files'], ['bytes', null, '容量 Stored'], ['pages', stats.pages.total, 'ページ Pages']] as [key, value, label] (key)}
				<div class="bg-[var(--archive-paper)] p-4">
					<div class="archive-title text-[32px] font-semibold leading-none tabular-nums">
						{key === 'bytes' ? formatBytes(stats.totals.deduplicatedBytes) : number(value)}
					</div>
					<div class="archive-kicker mt-2 text-[var(--archive-subtle)]">{label}</div>
				</div>
			{/each}
		</div>
		<p class="mt-2 text-[13px] text-[var(--archive-faint-text)]">
			Page counts are recorded for {number(stats.pages.recordedRevisions)} of
			{number(stats.totals.currentRevisions)} files; {number(stats.pages.unspecifiedRevisions)} do not
			report one. Stored objects: {number(stats.totals.storedObjects)}.
		</p>

		<!-- Text coverage -->
		<h2 class="archive-h2 mt-10">
			<BilingualLabel ja="本文の網羅率" en="Text coverage" />
		</h2>
		<p class="mt-2 text-[15px]">
			Of {number(pagesScanned)} scanned pages, {number(pagesWithText)}
			({percent(pagesWithText, pagesScanned)}%) have text aligned to a page, covering
			{number(stats.ocr.worksWithPageAlignedText)} of {number(stats.totals.works)} works.
			{number(stats.ocr.worksWithoutRecordedText)} works have no recorded text.
		</p>
		{#if stats.ocr.worksWithWholeDocumentText}
			<p class="mt-2 text-[15px]">
				A further {number(stats.ocr.worksWithWholeDocumentText)} works are searchable but hold their
				text as one block without page boundaries, so their pages are counted as lacking text here
				and searching them returns the work rather than a page.
			</p>
		{/if}
		<div class="mt-3 flex h-6 w-full overflow-hidden border border-[var(--archive-border)]">
			<div
				class="bg-[var(--archive-gilt)]"
				style={`width:${percent(pagesWithText, pagesScanned)}%`}
				title={`${pagesWithText} pages with text`}
			></div>
			<div class="flex-1 bg-[var(--archive-muted)]" title={`${pagesWithoutText} pages without text`}></div>
		</div>
		<p class="mt-2 text-[13px] text-[var(--archive-faint-text)]">
			Search indexes {number(stats.ocr.chunks)} text chunks.
		</p>

		<h3 class="archive-h3 mt-10">
			<BilingualLabel ja="OCRエンジン" en="OCR engines" />
		</h3>
		<p class="mt-1 text-[13px] text-[var(--archive-faint-text)]">
			Which tool produced the text matters when quoting it: pdftotext extracts text already present
			in a PDF, while the others read the image.
		</p>
		<table class="mt-3 w-full border-collapse text-[15px]">
			<tbody>
				{#each stats.ocr.variants as variant (variant.variant)}
					<tr class="border-b border-[var(--archive-border)]">
						<td class="py-2 font-mono text-[13px]">{variant.variant}</td>
						<td class="py-2 text-right tabular-nums">{number(variant.works)} {variant.works === 1 ? 'work' : 'works'}</td>
					</tr>
				{/each}
			</tbody>
		</table>

		<!-- Era and category -->
		<h2 class="archive-h2 mt-10">
			<BilingualLabel ja="収蔵の内訳" en="What kind of collection" />
		</h2>
		<div class="mt-3 space-y-1">
			{#each stats.distribution.era.values as bucket (bucket.value)}
				<div class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-[13px] tabular-nums text-[var(--archive-subtle)]">{bucket.value}</span>
					<span
						class="inline-block h-4 bg-[var(--archive-gilt)]"
						style={`width:${Math.max(2, (bucket.count / eraMax) * 70)}%`}
					></span>
					<span class="text-[13px] tabular-nums">{bucket.count}</span>
				</div>
			{/each}
			{#if stats.distribution.era.unspecified > 0}
				<div class="flex items-center gap-3">
					<span class="w-20 shrink-0 text-[13px] text-[var(--archive-faint-text)]">unknown</span>
					<span
						class="inline-block h-4 bg-[var(--archive-border)]"
						style={`width:${Math.max(2, (stats.distribution.era.unspecified / eraMax) * 70)}%`}
					></span>
					<span class="text-[13px] tabular-nums">{stats.distribution.era.unspecified}</span>
				</div>
			{/if}
		</div>
		<p class="mt-3 text-[15px]">
			{#each stats.distribution.category.values as category, index (category.value)}{index > 0
					? ' · '
					: ''}{category.value}: {number(category.count)}{/each}. The collection is mostly recent
			secondary literature; researchers looking for primary sources will find few here.
		</p>

		<!-- Dialect: prose, deliberately not a chart -->
		<h2 class="archive-h2 mt-10">
			<BilingualLabel ja="方言" en="Dialect" />
		</h2>
		<p class="mt-2 text-[15px]">
			Dialect is recorded for {number(stats.distribution.dialect.recorded)} of
			{number(stats.distribution.dialect.total)} works; the remaining
			{number(stats.distribution.dialect.unspecified)} are unspecified.
			{#if stats.distribution.dialect.values.length}
				Recorded: {#each stats.distribution.dialect.values as dialect, index (dialect.value)}{index >
					0
						? ', '
						: ''}{dialect.value}{/each}.
			{/if}
		</p>

		<!-- Search -->
		<h2 class="archive-h2 mt-10">
			<BilingualLabel ja="検索" en="Search" />
		</h2>
		<p class="mt-2 text-[15px]">
			Modes available: {stats.search.enabledModes.join(', ')}. Semantic search is not enabled for this
			corpus. <a class="underline" href="/archive/search">検索する Search the archive</a>
		</p>

		{#if stats.freshness?.mostRecentIngestAt}
			<p class="mt-8 text-[13px] text-[var(--archive-faint-text)]">
				Text last ingested {new Date(stats.freshness.mostRecentIngestAt).toISOString().slice(0, 16).replace('T', ' ')}.
			</p>
		{/if}
	</section>
{:else}
	<p class="text-[15px] text-[var(--archive-subtle)]">Statistics are unavailable for your role.</p>
{/if}
