<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref, deLocalizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import LanguageSwitcher from './LanguageSwitcher.svelte';
	import SearchBox from './SearchBox.svelte';

	let { user = null }: { user?: { name?: string } | null } = $props();

	let open = $state(false);

	const nav = [
		{ href: '/sources', label: () => m.nav_sources() },
		{ href: '/timeline', label: () => m.nav_timeline() },
		{ href: '/map', label: () => m.nav_map() },
		{ href: '/network', label: () => m.nav_network() },
		{ href: '/people', label: () => m.nav_people() },
		{ href: '/about', label: () => m.nav_about() }
	];

	const currentPath = $derived(deLocalizeHref(page.url.pathname));
	function isActive(href: string): boolean {
		return currentPath === href || currentPath.startsWith(href + '/');
	}
</script>

<header class="sticky top-0 z-40 border-b border-stone-200 bg-paper/90 backdrop-blur">
	<div class="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2.5">
		<a href={localizeHref('/')} class="flex shrink-0 items-center gap-2">
			<span
				class="grid size-8 place-items-center rounded-md bg-brand-700 font-serif text-sm font-bold text-white"
				aria-hidden="true">аэ</span
			>
			<span class="hidden font-serif text-base font-bold leading-tight text-ink sm:block"
				>{m.site_short()}</span
			>
		</a>

		<nav class="ml-2 hidden items-center gap-1 md:flex" aria-label="Primary">
			{#each nav as item (item.href)}
				<a
					href={localizeHref(item.href)}
					aria-current={isActive(item.href) ? 'page' : undefined}
					class="rounded-md px-2.5 py-1.5 text-sm font-medium text-stone-600 transition hover:bg-stone-100 hover:text-ink aria-[current=page]:bg-stone-100 aria-[current=page]:text-ink"
					>{item.label()}</a
				>
			{/each}
		</nav>

		<div class="ml-auto hidden min-w-0 flex-1 justify-end lg:flex">
			<div class="w-56"><SearchBox compact /></div>
		</div>

		<div class="ml-auto flex items-center gap-2 lg:ml-3">
			<div class="hidden sm:block"><LanguageSwitcher /></div>
			{#if user}
				<a
					href={localizeHref('/account')}
					class="hidden rounded-md px-2.5 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 sm:block"
					>{m.auth_account()}</a
				>
			{:else}
				<a
					href={localizeHref('/login')}
					class="hidden rounded-md bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 sm:block"
					>{m.auth_login()}</a
				>
			{/if}
			<button
				type="button"
				class="rounded-md p-2 text-stone-600 hover:bg-stone-100 md:hidden"
				aria-label={m.nav_menu()}
				aria-expanded={open}
				onclick={() => (open = !open)}
			>
				<svg viewBox="0 0 20 20" class="size-5" fill="none" stroke="currentColor" stroke-width="1.8">
					{#if open}
						<path d="M5 5l10 10M15 5L5 15" stroke-linecap="round" />
					{:else}
						<path d="M3 6h14M3 10h14M3 14h14" stroke-linecap="round" />
					{/if}
				</svg>
			</button>
		</div>
	</div>

	{#if open}
		<div class="border-t border-stone-200 px-4 py-3 md:hidden">
			<div class="mb-3"><SearchBox compact /></div>
			<nav class="flex flex-col gap-0.5" aria-label="Mobile">
				{#each nav as item (item.href)}
					<a
						href={localizeHref(item.href)}
						onclick={() => (open = false)}
						aria-current={isActive(item.href) ? 'page' : undefined}
						class="rounded-md px-2 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 aria-[current=page]:bg-stone-100"
						>{item.label()}</a
					>
				{/each}
				<a href={localizeHref('/places')} onclick={() => (open = false)} class="rounded-md px-2 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100">{m.nav_places()}</a>
				<a href={localizeHref('/institutions')} onclick={() => (open = false)} class="rounded-md px-2 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100">{m.nav_institutions()}</a>
			</nav>
			<div class="mt-3 flex items-center justify-between border-t border-stone-200 pt-3">
				<LanguageSwitcher />
				<a
					href={localizeHref(user ? '/account' : '/login')}
					class="text-sm font-medium text-brand-700">{user ? m.auth_account() : m.auth_login()}</a
				>
			</div>
		</div>
	{/if}
</header>
