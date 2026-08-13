<script lang="ts">
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	let {
		nextCursor,
		basePath = '/archive',
		params = '',
		busy = false,
		onLoadMore
	}: {
		nextCursor?: string | null;
		basePath?: string;
		params?: string;
		busy?: boolean;
		onLoadMore?: () => void;
	} = $props();

	const href = $derived(() => {
		const search = new URLSearchParams(params);
		if (nextCursor) search.set('cursor', nextCursor);
		const qs = search.toString();
		return qs ? `${basePath}?${qs}` : basePath;
	});

	let sentinel: HTMLElement | undefined = $state();

	// Fetch the next page before the reader reaches the end of the list, so
	// scrolling never runs into a hard stop. Recreating the observer when
	// `busy` clears makes it fire again immediately if the sentinel is still
	// in range — short pages keep filling until it leaves the viewport.
	$effect(() => {
		if (!sentinel || !onLoadMore || busy || !nextCursor) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
			},
			{ rootMargin: '600px 0px' }
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	});

	function click(event: MouseEvent): void {
		if (!onLoadMore) return;
		event.preventDefault();
		if (!busy) onLoadMore();
	}
</script>

{#if nextCursor}
	<div class="mt-6 text-center" bind:this={sentinel}>
		<a
			href={href()}
			aria-label={bilingualAriaLabel(busy ? archiveLabels.loading : archiveLabels.loadMore)}
			aria-busy={busy}
			onclick={click}
			class="inline-flex border border-[var(--archive-border)] bg-[var(--archive-paper)] px-4 py-2 text-[15px] font-medium text-[var(--archive-text)] hover:border-[var(--archive-gilt)]"
		>
			{#if busy}
				<BilingualLabel ja={archiveLabels.loading.ja} en={archiveLabels.loading.en} />
			{:else}
				<BilingualLabel ja={archiveLabels.loadMore.ja} en={archiveLabels.loadMore.en} />
			{/if}
		</a>
	</div>
{/if}
