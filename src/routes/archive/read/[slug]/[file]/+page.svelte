<script lang="ts">
	import UnderConstruction from '$lib/components/archive/UnderConstruction.svelte';
	let { data } = $props();
</script>

<UnderConstruction title={data.title} />
