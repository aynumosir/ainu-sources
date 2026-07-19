<script lang="ts">
	import ArchiveHead from '$lib/components/archive/ArchiveHead.svelte';
	import WorkspaceShell from '$lib/components/archive/WorkspaceShell.svelte';

	let { data }: { data: any } = $props();
</script>

<ArchiveHead title={data.source?.title ?? data.title ?? 'OCR workspace'} />

{#if !data.accessDenied}
	<WorkspaceShell
		file={data.file}
		revision={data.revision}
		source={data.source}
		initialPage={data.initialPage}
		role={data.role}
	/>
{/if}
