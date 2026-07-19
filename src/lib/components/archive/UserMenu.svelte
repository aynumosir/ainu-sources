<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { archiveUsage, type ArchiveUsage } from '$lib/archive/usage.svelte';
	import { formatBytes } from '$lib/archive/format';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
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
	const signOutEnhance: SubmitFunction = () => {
		return async ({ result, update }) => {
			if (result.type === 'success' || result.type === 'redirect') {
				await goto('/archive', { invalidateAll: true });
				return;
			}
			await update();
		};
	};
</script>

<div class="flex items-center gap-2">
	<span class="tnum hidden border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 py-1 text-[13px] text-[var(--archive-subtle)] sm:inline-flex">
		{used}{#if limit} / {limit}{/if}
	</span>
	<form method="POST" action="/account?/signout" use:enhance={signOutEnhance}>
		<button
			type="submit"
			aria-label={bilingualAriaLabel(archiveLabels.signOut)}
			class="h-8 border border-[var(--archive-border)] bg-[var(--archive-paper)] px-2 text-[13px] text-[var(--archive-text)] hover:border-[var(--archive-gilt)]"
		>
			<BilingualLabel ja={archiveLabels.signOut.ja} en={archiveLabels.signOut.en} />
		</button>
	</form>
	<div class="text-right">
		<div class="archive-mono text-[13px] font-medium text-[var(--archive-text)]">{principal.identity.value}</div>
		<div class="archive-kicker">{principal.role.replace('archive_', '')}</div>
	</div>
</div>
