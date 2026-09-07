<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import LanguageSwitcher from './LanguageSwitcher.svelte';
	import SearchBox from './SearchBox.svelte';
	import CatalogueNav from './CatalogueNav.svelte';

	let {
		user = null,
		hasArchiveAccess = false
	}: { user?: { name?: string } | null; hasArchiveAccess?: boolean } = $props();

	let open = $state(false);

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


		<div class="hidden md:block"><CatalogueNav {hasArchiveAccess} /></div>

		<div class="ml-auto hidden min-w-0 flex-1 justify-end lg:flex">
			<div class="w-40 xl:w-56"><SearchBox compact /></div>
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
			<CatalogueNav vertical {hasArchiveAccess} onNavigate={() => (open = false)} />
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
