<script lang="ts">
	import { page } from '$app/state';
	import { fade } from 'svelte/transition';
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import CollectionFacts from '$lib/components/archive/CollectionFacts.svelte';
	import ViewSwitch from '$lib/components/archive/ViewSwitch.svelte';
	import FilterBar from '$lib/components/archive/FilterBar.svelte';
	import SourceCardGrid from '$lib/components/archive/SourceCardGrid.svelte';
	import SourceList from '$lib/components/archive/SourceList.svelte';
	import PaginationCursor from '$lib/components/archive/PaginationCursor.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import { prefersReducedMotion } from '$lib/archive/motion';

	let { data } = $props();

	const view = $derived(page.url.searchParams.get('view') === 'list' ? 'list' : 'cards');
	// prefersReducedMotion() reads matchMedia, which is undefined during SSR;
	// $state settles this to the real value after the component mounts.
	let fadeInMs = $state(220);
	$effect(() => {
		if (prefersReducedMotion()) fadeInMs = 0;
	});
</script>

<ArchiveHead title="資料一覧 Library" />

<div class="space-y-5">
	<header class="archive-rule-dotted space-y-3 pb-4">
		<div class="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
			<BilingualLabel
				tag="h1"
				stacked
				ja={archiveLabels.library.ja}
				en={archiveLabels.library.en}
				class="archive-h1"
			/>
			{#if data.stats}
				<CollectionFacts stats={data.stats} />
			{/if}
		</div>
	</header>

	<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
		<ViewSwitch />
		<p class="archive-seal-legend text-[11px] text-[var(--archive-subtle)]">
			<BilingualLabel ja={archiveLabels.sealLegend.ja} en={archiveLabels.sealLegend.en} />
		</p>
	</div>

	<FilterBar filters={data.filters} />

	{#if view === 'cards'}
		<div in:fade={{ duration: fadeInMs }}>
			<SourceCardGrid items={data.items} />
		</div>
	{:else}
		<div in:fade={{ duration: fadeInMs }}>
			<SourceList items={data.items} />
		</div>
	{/if}

	<PaginationCursor nextCursor={data.nextCursor} params={data.params} />
</div>

<style>
	.archive-seal-legend :global(.en) {
		display: none;
	}
	@media (min-width: 640px) {
		.archive-seal-legend :global(.ja) {
			display: none;
		}
		.archive-seal-legend :global(.en) {
			display: inline;
		}
	}
</style>
