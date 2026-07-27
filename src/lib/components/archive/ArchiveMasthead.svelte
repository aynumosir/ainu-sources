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
		{ href: '/archive/stats', label: { ja: '統計', en: 'Statistics' }, section: 'stats' }
	] as const;

	function isCurrent(section: (typeof navItems)[number]['section']): boolean {
		const pathname: string = page.url.pathname;
		if (section === 'stats') return pathname === '/archive/stats' || pathname.startsWith('/archive/stats/');
		return (
			pathname === '/archive' ||
			pathname.startsWith('/archive/work/') ||
			pathname.startsWith('/archive/sources/') ||
			pathname.startsWith('/archive/read/')
		);
	}

	const onSearchPage = $derived(page.url.pathname.startsWith('/archive/search'));
	// The header box asks the same underlying question as the search page's
	// own field, so it starts pre-filled there and only there — leaving other
	// pages' searches empty rather than showing a stale query from wherever
	// the reader was before.
	const searchValue = $derived(onSearchPage ? page.url.searchParams.get('q') ?? '' : '');
</script>

{#snippet searchBox(id: string)}
	<form action="/archive/search" method="get" class="min-w-0 flex-1 sm:max-w-sm">
		<label class="sr-only" for={id}>
			<BilingualLabel ja={archiveLabels.search.ja} en={archiveLabels.search.en} />
		</label>
		<div class="relative">
			<svg
				class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--archive-faint-text)]"
				viewBox="0 0 20 20"
				fill="none"
				stroke="currentColor"
				stroke-width="1.6"
				aria-hidden="true"
			>
				<circle cx="8.5" cy="8.5" r="5.5" />
				<path d="M17 17l-4-4" stroke-linecap="round" />
			</svg>
			<input
				{id}
				name="q"
				value={searchValue}
				placeholder="本文を検索 Search text…"
				class="h-9 w-full rounded-none border border-[var(--archive-border)] bg-[var(--archive-panel)] pl-8 pr-3 text-[14px] text-[var(--archive-text)] placeholder:text-[var(--archive-faint-text)] focus:border-[var(--archive-gilt)] focus:outline-none"
			/>
		</div>
	</form>
{/snippet}

{#snippet navLinks()}
	{#each navItems as item (item.href)}
		<a
			class={`shrink-0 border-b px-0.5 pb-1 font-(family-name:--font-archive-serif) font-semibold text-[var(--archive-subtle)] transition hover:border-[var(--archive-gilt)] hover:text-[var(--archive-text)] ${
				isCurrent(item.section) ? 'border-[var(--archive-gilt)] text-[var(--archive-text)]' : 'border-transparent'
			}`}
			href={item.href}
			aria-label={bilingualAriaLabel(item.label)}
		>
			<BilingualLabel ja={item.label.ja} en={item.label.en} />
		</a>
	{/each}
{/snippet}

<header class="sticky top-0 z-40 border-b border-[var(--archive-border-strong)] bg-[var(--archive-paper)]">
	<div class="mx-auto max-w-[96rem] px-4 py-2">
		<!-- Below sm: wordmark + user menu on their own row, search + nav on a
		     second full-width row — a single row has no width left for all
		     four once the viewport narrows past a phone. -->
		<div class="flex min-h-10 items-center gap-3">
			<a href="/archive" class="archive-wordmark shrink-0 text-[21px] leading-tight text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]">
				aynumosir archive
			</a>
			<div class="hidden min-w-0 flex-1 items-center gap-3 sm:flex">
				{@render searchBox('archive-masthead-search-wide')}
				<nav class="ml-auto flex min-w-0 items-center gap-4 overflow-x-auto text-[13px]" aria-label="Archive">
					{@render navLinks()}
				</nav>
			</div>
			<div class="ml-auto shrink-0 sm:ml-0">
				<UserMenu {principal} {usage} {displayName} />
			</div>
		</div>
		<div class="flex items-center gap-3 pb-2 pt-2 sm:hidden">
			{@render searchBox('archive-masthead-search-narrow')}
			<nav class="flex shrink-0 items-center gap-3 text-[13px]" aria-label="Archive">
				{@render navLinks()}
			</nav>
		</div>
	</div>
</header>
