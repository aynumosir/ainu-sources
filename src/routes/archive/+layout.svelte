<script lang="ts">
	import './archive.css';
	import ArchiveRouteShell from '$lib/components/archive/ArchiveRouteShell.svelte';

	let { children, data } = $props();
</script>

<ArchiveRouteShell {children} {data} />
