<script lang="ts">
	import WorkView from '$lib/components/archive/WorkView.svelte';

	let { data } = $props();
</script>

{#if data.work && !data.work.unavailable}
	<WorkView work={data.work} />
{:else if data.work?.unavailable}
	<section class="mx-auto max-w-lg p-8 text-center text-[15px] text-[var(--archive-subtle)]">
		No readable archive file is available for this work.
	</section>
{/if}
