<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import UnderConstruction from '$lib/components/archive/UnderConstruction.svelte';
	let { data } = $props();
</script>

<ArchiveHead title="アップロード Upload" />


<UnderConstruction title={data.title} />
