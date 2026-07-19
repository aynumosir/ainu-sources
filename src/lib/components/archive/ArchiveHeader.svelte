<script lang="ts">
	import GlobalSearchBox from './GlobalSearchBox.svelte';
	import UserMenu from './UserMenu.svelte';
	import RoleGate from './RoleGate.svelte';
	import type { ArchivePrincipal } from '$lib/server/archive/types';
	import type { ArchiveUsage } from '$lib/archive/usage.svelte';

	let {
		principal,
		usage,
		pendingCount = 0,
		q = ''
	}: {
		principal: Pick<ArchivePrincipal, 'userId' | 'role' | 'identity' | 'authn'>;
		usage: ArchiveUsage;
		pendingCount?: number;
		q?: string;
	} = $props();
</script>

<header class="border-b border-[var(--archive-border)] bg-[var(--archive-surface)]">
	<div class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 lg:flex-row lg:items-center">
		<div class="flex items-center justify-between gap-4">
			<a href="/archive" class="text-[17px] font-semibold text-[var(--archive-text)]">aynumosir archive</a>
			<div class="lg:hidden">
				<UserMenu {principal} {usage} />
			</div>
		</div>
		<nav class="flex flex-wrap items-center gap-1 text-[13px]" aria-label="Archive">
			<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive">Library</a>
			<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive/search">Search</a>
			<RoleGate role={principal.role} min="archive_contributor">
				<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive/uploads">Uploads</a>
			</RoleGate>
			<RoleGate role={principal.role} min="archive_reviewer">
				<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive/review">
					Review{#if pendingCount > 0}<span class="ml-1 rounded-full bg-[var(--archive-accent)] px-1.5 py-0.5 text-[11px] text-white">{pendingCount}</span>{/if}
				</a>
			</RoleGate>
			<RoleGate role={principal.role} min="archive_admin">
				<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive/admin">Admin</a>
			</RoleGate>
			<a class="rounded-md px-2.5 py-1.5 text-[var(--archive-subtle)] hover:bg-[var(--archive-muted)] hover:text-[var(--archive-text)]" href="/archive/account">Account</a>
		</nav>
		<div class="flex min-w-0 flex-1 items-center gap-4">
			<GlobalSearchBox {q} />
			<div class="hidden lg:block">
				<UserMenu {principal} {usage} />
			</div>
		</div>
	</div>
</header>
