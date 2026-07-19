<script lang="ts">
	import { page } from '$app/state';
	import UserMenu from './UserMenu.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import type { ArchivePrincipal } from '$lib/server/archive/types';
	import type { ArchiveUsage } from '$lib/archive/usage.svelte';

	let {
		principal,
		usage,
		displayName
	}: {
		principal: Pick<ArchivePrincipal, 'role'>;
		usage: ArchiveUsage;
		displayName: string;
	} = $props();

	const navItems = [
		{ href: '/archive', label: archiveLabels.library, section: 'library' },
		{ href: '/archive/search', label: archiveLabels.search, section: 'search' },
		{ href: '/archive/stats', label: { ja: '統計', en: 'Statistics' }, section: 'stats' }
	] as const;

	function isCurrent(section: (typeof navItems)[number]['section']): boolean {
		const pathname: string = page.url.pathname;
		if (section === 'search') return pathname === '/archive/search' || pathname.startsWith('/archive/search/');
		if (section === 'stats') return pathname === '/archive/stats' || pathname.startsWith('/archive/stats/');
		return (
			pathname === '/archive' ||
			pathname.startsWith('/archive/work/') ||
			pathname.startsWith('/archive/sources/') ||
			pathname.startsWith('/archive/read/')
		);
	}
</script>

<header class="sticky top-0 z-40 border-b border-[var(--archive-border-strong)] bg-[var(--archive-paper)]">
	<div class="mx-auto flex min-h-14 max-w-[96rem] items-center gap-4 px-4 py-2">
		<a href="/archive" class="archive-wordmark shrink-0 text-[21px] leading-tight text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]">
			aynumosir archive
		</a>

		<nav class="ml-auto flex min-w-0 items-center gap-2 overflow-x-auto text-[13px] sm:ml-4 sm:gap-4" aria-label="Archive">
			{#each navItems as item (item.href)}
				<a
					class={`shrink-0 border-b px-0.5 pb-1 font-[var(--font-archive-serif)] font-semibold text-[var(--archive-subtle)] transition hover:border-[var(--archive-gilt)] hover:text-[var(--archive-text)] ${
						isCurrent(item.section) ? 'border-[var(--archive-gilt)] text-[var(--archive-text)]' : 'border-transparent'
					}`}
					href={item.href}
					aria-label={bilingualAriaLabel(item.label)}
				>
					<BilingualLabel ja={item.label.ja} en={item.label.en} />
				</a>
			{/each}
		</nav>

		<div class="ml-auto shrink-0">
			<UserMenu {principal} {usage} {displayName} />
		</div>
	</div>
</header>
