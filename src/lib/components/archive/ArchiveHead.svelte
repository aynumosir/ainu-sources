<script lang="ts">
	/**
	 * Per-page document metadata for archive routes. The archive is a private
	 * collection, so every page carries a noindex directive and suppresses
	 * referrers regardless of what the route itself renders.
	 */
	let { title, description = '' }: { title: string; description?: string } = $props();

	const full = $derived(title ? `${title} · aynumosir archive` : 'aynumosir archive');
</script>

<svelte:head>
	<title>{full}</title>
	<meta name="robots" content="noindex, nofollow, noarchive, noimageindex" />
	<meta name="referrer" content="no-referrer" />
	{#if description}
		<meta name="description" content={description} />
	{/if}
</svelte:head>
