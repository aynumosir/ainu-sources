<script lang="ts">
	import { archiveRoleAtLeastClient, type ArchiveRoleName } from '$lib/archive/roles';

	let {
		role,
		min,
		children,
		fallback
	}: {
		role: ArchiveRoleName | null | undefined;
		min: ArchiveRoleName;
		children: import('svelte').Snippet;
		fallback?: import('svelte').Snippet;
	} = $props();

	const allowed = $derived(!!role && archiveRoleAtLeastClient(role, min));
</script>

{#if allowed}
	{@render children()}
{:else if fallback}
	{@render fallback()}
{/if}
