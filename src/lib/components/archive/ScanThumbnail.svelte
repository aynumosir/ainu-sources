<script lang="ts">
	let {
		revisionId,
		title
	}: {
		revisionId: string | null;
		title: string;
	} = $props();

	let failed = $state(false);
	const initial = $derived(title.trim().slice(0, 1) || 'A');
	const src = $derived(revisionId ? `/api/archive/revisions/${revisionId}/pages/1.webp?w=300` : null);
</script>

<div class="flex aspect-[4/5] w-full items-center justify-center overflow-hidden border border-[var(--archive-border)] bg-[var(--archive-bg)]">
	{#if src && !failed}
		<img
			{src}
			alt=""
			class="h-full w-full object-cover"
			loading="lazy"
			onerror={() => {
				failed = true;
			}}
		/>
	{:else}
		<span class="archive-title text-[27px] font-semibold text-[var(--archive-subtle)]">{initial}</span>
	{/if}
</div>
