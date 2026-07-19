<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import FilterBar from '$lib/components/archive/FilterBar.svelte';
	import SourceCardGrid from '$lib/components/archive/SourceCardGrid.svelte';
	import PaginationCursor from '$lib/components/archive/PaginationCursor.svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	let { data } = $props();
</script>

<ArchiveHead title="資料一覧 Library" />


<div class="space-y-5">
	<div class="archive-rule-dotted flex flex-col gap-2 pb-3 md:flex-row md:items-end md:justify-between">
		<div>
			<BilingualLabel
				tag="h1"
				stacked
				ja={archiveLabels.library.ja}
				en={archiveLabels.library.en}
				class="text-[27px] font-semibold"
			/>
			<p class="mt-1 text-[15px] text-[var(--archive-subtle)]">Approved current files available in the restricted archive.</p>
		</div>
	</div>
	<FilterBar filters={data.filters} />
	<SourceCardGrid items={data.items} />
	<PaginationCursor nextCursor={data.nextCursor} params={data.params} />
</div>
