<script lang="ts">
	import { archiveUsage, type ArchiveUsage } from '$lib/archive/usage.svelte';
	import { archiveSession, setArchiveTheme } from '$lib/archive/session.svelte';
	import { formatBytes } from '$lib/archive/format';
	import type { ArchivePrincipal } from '$lib/server/archive/types';

	let {
		principal,
		usage
	}: {
		principal: Pick<ArchivePrincipal, 'role' | 'identity'>;
		usage: ArchiveUsage;
	} = $props();

	$effect(() => {
		archiveUsage.value = usage;
	});

	const used = $derived(archiveUsage.value ? formatBytes(archiveUsage.value.bytesUsed) : 'no usage data');
	const limit = $derived(archiveUsage.value ? formatBytes(archiveUsage.value.dailyByteLimit) : '');
</script>

<div class="flex items-center gap-2">
	<span class="hidden rounded-md border border-[var(--archive-border)] px-2 py-1 text-[13px] text-[var(--archive-subtle)] sm:inline-flex">
		{used}{#if limit} / {limit}{/if}
	</span>
	<select
		aria-label="Theme"
		value={archiveSession.theme}
		onchange={(event) => setArchiveTheme(event.currentTarget.value as 'system' | 'light' | 'dark')}
		class="h-8 rounded-md border border-[var(--archive-border)] bg-[var(--archive-surface)] px-2 text-[13px] text-[var(--archive-text)]"
	>
		<option value="system">System</option>
		<option value="light">Light</option>
		<option value="dark">Dark</option>
	</select>
	<div class="text-right">
		<div class="text-[13px] font-medium text-[var(--archive-text)]">{principal.identity.value}</div>
		<div class="text-[12px] text-[var(--archive-subtle)]">{principal.role.replace('archive_', '')}</div>
	</div>
</div>
