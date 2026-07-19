<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';

	let {
		nextCursor,
		basePath = '/archive',
		params = ''
	}: {
		nextCursor?: string | null;
		basePath?: string;
		params?: string;
	} = $props();

	const href = $derived(() => {
		const search = new URLSearchParams(params);
		if (nextCursor) search.set('cursor', nextCursor);
		const qs = search.toString();
		return qs ? `${basePath}?${qs}` : basePath;
	});
</script>

{#if nextCursor}
	<div class="mt-6 text-center">
		<a href={href()} class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-paper)] px-4 py-2 text-[15px] font-medium text-[var(--archive-text)] hover:border-[var(--archive-gilt)]">
			<BilingualLabel ja={archiveLabels.loadMore.ja} en={archiveLabels.loadMore.en} />
		</a>
	</div>
{/if}
