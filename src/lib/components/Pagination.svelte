<script lang="ts">
	import { page as appPage } from '$app/state';
	import { localizeHref, deLocalizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { page, pageCount }: { page: number; pageCount: number } = $props();

	function hrefFor(p: number): string {
		const params = new URLSearchParams(appPage.url.search);
		if (p <= 1) params.delete('page');
		else params.set('page', String(p));
		const path = deLocalizeHref(appPage.url.pathname);
		const qs = params.toString();
		return localizeHref(qs ? `${path}?${qs}` : path);
	}

	// windowed page numbers
	const pages = $derived.by(() => {
		const out: number[] = [];
		const from = Math.max(1, page - 2);
		const to = Math.min(pageCount, page + 2);
		for (let i = from; i <= to; i++) out.push(i);
		return out;
	});
</script>

{#if pageCount > 1}
	<nav class="mt-8 flex items-center justify-center gap-1" aria-label="Pagination">
		<a
			href={hrefFor(page - 1)}
			aria-disabled={page <= 1}
			class="rounded-md px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40"
			>{m.prev_page()}</a
		>
		{#if pages[0] > 1}
			<a href={hrefFor(1)} class="rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">1</a>
			{#if pages[0] > 2}<span class="px-1 text-stone-400">…</span>{/if}
		{/if}
		{#each pages as p (p)}
			<a
				href={hrefFor(p)}
				aria-current={p === page ? 'page' : undefined}
				class="tnum rounded-md px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 aria-[current=page]:bg-brand-700 aria-[current=page]:text-white"
				>{p}</a
			>
		{/each}
		{#if pages[pages.length - 1] < pageCount}
			{#if pages[pages.length - 1] < pageCount - 1}<span class="px-1 text-stone-400">…</span>{/if}
			<a href={hrefFor(pageCount)} class="tnum rounded-md px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">{pageCount}</a>
		{/if}
		<a
			href={hrefFor(page + 1)}
			aria-disabled={page >= pageCount}
			class="rounded-md px-3 py-1.5 text-sm font-medium text-stone-600 hover:bg-stone-100 aria-[disabled=true]:pointer-events-none aria-[disabled=true]:opacity-40"
			>{m.next_page()}</a
		>
	</nav>
{/if}
