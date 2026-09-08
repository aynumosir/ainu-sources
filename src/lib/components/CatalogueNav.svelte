<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref, deLocalizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { vertical = false, hasArchiveAccess = false, onNavigate = () => {} }: {
		vertical?: boolean; hasArchiveAccess?: boolean; onNavigate?: () => void;
	} = $props();
	let expanded = $state(false);
	let disclosure: HTMLDetailsElement;
	const currentPath = $derived(deLocalizeHref(page.url.pathname));
	const active = (href: string) => currentPath === href || currentPath.startsWith(href + '/');
	const explore = [
		{ href: '/timeline', label: () => m.nav_timeline() },
		{ href: '/network', label: () => m.nav_network() },
		{ href: '/people', label: () => m.nav_people() },
		{ href: '/places', label: () => m.nav_places() },
		{ href: '/institutions', label: () => m.nav_institutions() }
	];
	function closeExplore() { expanded = false; if (disclosure) disclosure.open = false; }
	function navigate() { closeExplore(); onNavigate(); }
	const linkClass = 'rounded-md px-2.5 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 hover:text-ink aria-[current=page]:bg-stone-100 aria-[current=page]:text-ink';
</script>

<svelte:window onclick={(event) => { if (event.target instanceof Node && !disclosure?.contains(event.target)) closeExplore(); }} onkeydown={(event) => {
	if (event.key === 'Escape' && disclosure?.open) { closeExplore(); disclosure?.querySelector('summary')?.focus(); }
}} />

<nav class={vertical ? 'flex flex-col gap-1' : 'flex items-center gap-1'} aria-label={vertical ? 'Mobile' : 'Primary'}>
	<a href={localizeHref('/sources')} class={linkClass} aria-current={active('/sources') ? 'page' : undefined} onclick={navigate}>{m.nav_sources()}</a>
	<details class="relative" bind:this={disclosure} bind:open={expanded}>
		<summary class="cursor-pointer rounded-md px-2.5 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100" class:bg-stone-100={explore.some((item) => active(item.href))}>{m.nav_explore()}</summary>
		<div class={vertical ? 'ml-3 flex flex-col gap-1 border-l border-stone-200 pl-2' : 'absolute left-0 top-full z-50 mt-2 flex min-w-48 flex-col gap-1 rounded-lg border border-stone-200 bg-paper-card p-2 shadow-lg'}>
			{#each explore as item (item.href)}
				<a href={localizeHref(item.href)} class={linkClass} aria-current={active(item.href) ? 'page' : undefined} onclick={navigate}>{item.label()}</a>
			{/each}
		</div>
	</details>
	<a href={localizeHref('/about')} class={linkClass} aria-current={active('/about') ? 'page' : undefined} onclick={navigate}>{m.nav_about()}</a>
	{#if hasArchiveAccess}
		<a href="/archive" class={linkClass} aria-current={active('/archive') ? 'page' : undefined} onclick={navigate}>{m.nav_archive()}</a>
	{/if}
</nav>
