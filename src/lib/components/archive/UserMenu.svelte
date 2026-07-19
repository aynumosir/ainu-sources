<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { archiveSession, setArchiveTheme } from '$lib/archive/session.svelte';
	import { archiveUsage, type ArchiveUsage } from '$lib/archive/usage.svelte';
	import { archiveRoleLabel } from '$lib/archive/identity';
	import { formatBytes } from '$lib/archive/format';
	import type { ArchivePrincipal } from '$lib/server/archive/types';

	let {
		principal,
		usage,
		displayName
	}: {
		principal: Pick<ArchivePrincipal, 'role'>;
		usage: ArchiveUsage;
		displayName: string;
	} = $props();

	let menu: HTMLDetailsElement | undefined = $state();

	$effect(() => {
		archiveUsage.value = usage;
	});

	const role = $derived(archiveRoleLabel(principal.role));
	const usageRatio = $derived(
		archiveUsage.value && archiveUsage.value.dailyByteLimit > 0
			? archiveUsage.value.bytesUsed / archiveUsage.value.dailyByteLimit
			: 0
	);
	const usagePercent = $derived(Math.min(100, Math.max(0, usageRatio * 100)));
	const usageLine = $derived(
		archiveUsage.value
			? `${formatBytes(archiveUsage.value.bytesUsed)} of ${formatBytes(archiveUsage.value.dailyByteLimit)}`
			: 'Usage unavailable'
	);

	const signOutEnhance: SubmitFunction = () => {
		return async ({ result, update }) => {
			if (result.type === 'success' || result.type === 'redirect') {
				await goto('/archive', { invalidateAll: true });
				return;
			}
			await update();
		};
	};

	function chooseTheme(theme: 'light' | 'dark' | 'system'): void {
		setArchiveTheme(theme);
	}
</script>

<details bind:this={menu} class="relative">
	<summary
		class="flex cursor-pointer list-none items-center gap-2 text-[13px] font-medium text-[var(--archive-text)] marker:hidden hover:text-[var(--archive-gilt-text)]"
		aria-label={`Account menu for ${displayName}`}
	>
		<span class="relative max-w-44 truncate">
			{displayName}
			{#if usageRatio > 0.8}
				<span
					class="absolute -right-2 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-500"
					aria-label="Usage above 80%"
				></span>
			{/if}
		</span>
		<span aria-hidden="true" class="text-[11px] text-[var(--archive-subtle)]">⌄</span>
	</summary>

	<div class="absolute right-0 z-50 mt-3 w-64 border border-[var(--archive-border-strong)] bg-[var(--archive-paper)] p-4 shadow-lg">
		<p class="text-[15px] font-semibold text-[var(--archive-text)]">{displayName}</p>
		<p class="mt-0.5 text-[13px] text-[var(--archive-subtle)]">{role}</p>

		<div class="mt-4 border-t border-dotted border-[var(--archive-border)] pt-3">
			<div class="flex items-center justify-between gap-3 text-[12px] text-[var(--archive-subtle)]">
				<span>Usage</span>
				<span class="tnum">{usageLine}</span>
			</div>
			<div class="mt-2 h-1 overflow-hidden bg-[var(--archive-muted)]" role="progressbar" aria-label="Archive usage" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(usagePercent)}>
				<div class="h-full bg-[var(--archive-gilt)]" style={`width:${usagePercent}%`}></div>
			</div>
		</div>

		<fieldset class="mt-4 border-t border-dotted border-[var(--archive-border)] pt-3">
			<legend class="text-[12px] text-[var(--archive-subtle)]">Theme</legend>
			<div class="mt-2 grid grid-cols-3 border border-[var(--archive-border)] text-[12px]">
				{#each [
					{ value: 'light', label: 'Light' },
					{ value: 'dark', label: 'Dark' },
					{ value: 'system', label: 'Auto' }
				] as option (option.value)}
					<button
						type="button"
						aria-pressed={archiveSession.theme === option.value}
						onclick={() => chooseTheme(option.value as 'light' | 'dark' | 'system')}
						class={`px-2 py-1.5 first:border-0 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-[var(--archive-border)] ${
							archiveSession.theme === option.value
								? 'bg-[var(--archive-gilt)] text-[var(--archive-paper)]'
								: 'bg-[var(--archive-paper)] text-[var(--archive-subtle)] hover:bg-[var(--archive-panel)]'
						}`}
					>
						{option.label}
					</button>
				{/each}
			</div>
		</fieldset>

		<div class="mt-4 space-y-2 border-t border-dotted border-[var(--archive-border)] pt-3 text-[13px]">
			<a href="/archive/account" class="block text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]" onclick={() => menu?.removeAttribute('open')}>Account</a>
			<form method="POST" action="/account?/signout" use:enhance={signOutEnhance}>
				<button type="submit" class="text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]">Sign out</button>
			</form>
		</div>
	</div>
</details>
