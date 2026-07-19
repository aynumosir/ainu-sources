<script lang="ts">
	import { page } from '$app/state';
	import GlobalSearchBox from './GlobalSearchBox.svelte';
	import UserMenu from './UserMenu.svelte';
	import RoleGate from './RoleGate.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import { archiveSession, setArchiveTheme } from '$lib/archive/session.svelte';
	import type { ArchivePrincipal } from '$lib/server/archive/types';
	import type { ArchiveUsage } from '$lib/archive/usage.svelte';

	type NavItem = {
		href: string;
		label: (typeof archiveLabels)[keyof typeof archiveLabels];
		min?: ArchivePrincipal['role'];
		badge?: number;
	};

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

	const navItems = $derived<NavItem[]>([
		{ href: '/archive', label: archiveLabels.library },
		{ href: '/archive/upload', label: archiveLabels.upload, min: 'archive_contributor' },
		{ href: '/archive/review', label: archiveLabels.review, min: 'archive_reviewer', badge: pendingCount },
		{ href: '/archive/admin', label: archiveLabels.admin, min: 'archive_admin' }
	]);

	function isCurrent(href: string): boolean {
		const pathname = page.url.pathname;
		if (href === '/archive') return pathname === '/archive';
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	function cycleTheme(): void {
		const next = archiveSession.theme === 'system' ? 'light' : archiveSession.theme === 'light' ? 'dark' : 'system';
		setArchiveTheme(next);
	}

	const themeName = $derived(archiveSession.theme === 'system' ? 'system theme' : `${archiveSession.theme} theme`);
</script>

<header class="sticky top-0 z-40 border-b border-[var(--archive-border-strong)] bg-[var(--archive-paper)]">
	<div class="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 lg:grid lg:grid-cols-[auto_minmax(16rem,1fr)_auto] lg:items-center">
		<div class="flex items-center justify-between gap-4">
			<a href="/archive" class="leading-tight text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]">
				<span class="archive-wordmark block text-[21px]">aynumosir archive</span>
				{#if page.url.pathname === '/archive'}
					<span class="mt-0.5 block font-[var(--font-archive-jp)] text-[13px] text-[var(--archive-faint-text)]">
						アイヌモシㇼ資料記録庫
					</span>
				{/if}
			</a>
			<div class="lg:hidden">
				<UserMenu {principal} {usage} />
			</div>
		</div>

		<div class="min-w-0">
			<GlobalSearchBox {q} />
		</div>

		<div class="flex flex-wrap items-center gap-4">
			<nav class="flex flex-wrap items-center gap-2 text-[13px]" aria-label="Archive">
				{#each navItems as item (item.href)}
					{#if item.min}
						<RoleGate role={principal.role} min={item.min}>
							<a
								class={`border-b px-1 pb-1 font-[var(--font-archive-serif)] font-semibold text-[var(--archive-subtle)] transition [font-variant:small-caps] hover:border-[var(--archive-gilt)] hover:text-[var(--archive-text)] ${
									isCurrent(item.href) ? 'border-[var(--archive-gilt)] text-[var(--archive-text)]' : 'border-transparent'
								}`}
								href={item.href}
								aria-label={bilingualAriaLabel(item.label)}
							>
								<BilingualLabel ja={item.label.ja} en={item.label.en} />
								{#if item.badge && item.badge > 0}
									<span class="ml-1 rounded-full bg-[var(--archive-gilt)] px-1.5 py-0.5 text-[13px] text-[var(--archive-paper)]">{item.badge}</span>
								{/if}
							</a>
						</RoleGate>
					{:else}
						<a
							class={`border-b px-1 pb-1 font-[var(--font-archive-serif)] font-semibold text-[var(--archive-subtle)] transition [font-variant:small-caps] hover:border-[var(--archive-gilt)] hover:text-[var(--archive-text)] ${
								isCurrent(item.href) ? 'border-[var(--archive-gilt)] text-[var(--archive-text)]' : 'border-transparent'
							}`}
							href={item.href}
							aria-label={bilingualAriaLabel(item.label)}
						>
							<BilingualLabel ja={item.label.ja} en={item.label.en} />
						</a>
					{/if}
				{/each}
			</nav>
			<button
				type="button"
				aria-label={`Theme: ${themeName}. Change theme`}
				title={`Theme: ${themeName}`}
				onclick={cycleTheme}
				class={`archive-theme-toggle flex h-8 w-8 items-center justify-center border text-[17px] leading-none transition hover:border-[var(--archive-gilt)] hover:text-[var(--archive-text)] ${
					archiveSession.theme === 'system'
						? 'border-[var(--archive-border)] bg-[var(--archive-paper)] text-[var(--archive-subtle)]'
						: 'border-[var(--archive-gilt)] bg-[var(--archive-panel)] text-[var(--archive-gilt-text)]'
				}`}
			>
				<span aria-hidden="true">◐</span>
			</button>
			<div class="hidden lg:block">
				<UserMenu {principal} {usage} />
			</div>
		</div>
	</div>
</header>
