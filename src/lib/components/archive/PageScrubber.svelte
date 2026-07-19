<script lang="ts">
	import type { PageStatusRow } from '$lib/archive/workspace';

	let {
		page,
		pageCount,
		statuses,
		dirtyPages,
		thumbnailSrc = null,
		onpage
	}: {
		page: number;
		pageCount: number;
		statuses: PageStatusRow[];
		dirtyPages: number[];
		thumbnailSrc?: string | null;
		onpage: (page: number) => void;
	} = $props();

	const statusByPage = $derived(new Map(statuses.map((row) => [row.page, row])));
	const dirtySet = $derived(new Set(dirtyPages));
	const thumbLeft = $derived(pageCount <= 1 ? 0 : ((page - 1) / (pageCount - 1)) * 100);
</script>

<div class="scrubber">
	<div class="thumb" style={`left:${thumbLeft}%`} aria-hidden="true">
		{#if thumbnailSrc}<img src={thumbnailSrc} alt="" />{/if}
		<span>{page}</span>
	</div>
	<input
		type="range"
		min="1"
		max={pageCount}
		value={page}
		aria-label="Scan page"
		oninput={(event) => onpage(Number(event.currentTarget.value))}
	/>
	<div class="ticks" aria-hidden="true">
		{#each Array(pageCount) as _, index}
			{@const tickPage = index + 1}
			{@const row = statusByPage.get(tickPage)}
			<span
				class:dirty={dirtySet.has(tickPage)}
				class:approved={row?.status === 'approved'}
				class:edited={row?.status === 'edited'}
				style={`left:${pageCount <= 1 ? 0 : (index / (pageCount - 1)) * 100}%`}
			></span>
		{/each}
	</div>
</div>

<style>
	.scrubber {
		position: relative;
		padding: 0.35rem 0.9rem 0.55rem;
	}
	input { display: block; width: 100%; height: 1rem; }
	.thumb {
		position: absolute;
		bottom: 1.35rem;
		z-index: 3;
		width: 2.5rem;
		height: 3.2rem;
		transform: translateX(-50%);
		border: 1px solid var(--archive-gilt);
		background: var(--archive-paper);
		box-shadow: 0 2px 6px rgb(0 0 0 / 22%);
		overflow: hidden;
		pointer-events: none;
	}
	.thumb img { width: 100%; height: 100%; object-fit: cover; }
	.thumb span { position: absolute; right: 1px; bottom: 0; background: rgb(0 0 0 / 65%); padding: 0 2px; color: white; font-size: 9px; }
	.ticks { position: relative; height: 0.35rem; margin: 0 0.2rem; }
	.ticks span { position: absolute; top: 0; width: 2px; height: 4px; transform: translateX(-1px); background: var(--archive-border-strong); }
	.ticks span.edited { background: var(--archive-warn); }
	.ticks span.approved { background: var(--archive-good); }
	.ticks span.dirty { width: 5px; height: 5px; transform: translateX(-2px); border: 1px solid var(--archive-warn); border-radius: 999px; background: var(--archive-paper); }
</style>
