<script lang="ts">
	import { page } from '$app/state';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	const is404 = $derived(page.status === 404);
	const title = $derived(is404 ? m.error_404_title() : m.error_generic_title());
	const body = $derived(is404 ? m.error_404_body() : m.error_generic_body());
</script>

<svelte:head>
	<title>{page.status} · {title} · {m.site_short()}</title>
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<div class="mx-auto flex min-h-svh max-w-2xl flex-col items-center justify-center px-4 py-24 text-center">
	<p class="font-serif text-7xl font-bold text-stone-300">{page.status}</p>
	<h1 class="mt-4 font-serif text-2xl font-bold text-ink">{title}</h1>
	<p class="mt-2 text-sm text-stone-500">{body}</p>
	{#if page.error?.message && !is404}
		<p class="mt-4 max-w-md rounded-md bg-stone-100 px-3 py-2 font-mono text-xs break-words text-stone-500">
			{page.error.message}
		</p>
	{/if}
	<div class="mt-8 flex flex-wrap items-center justify-center gap-3">
		<a
			href={localizeHref('/')}
			class="inline-flex items-center justify-center rounded-md bg-brand-700 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-brand-800"
		>
			{m.error_back_home()}
		</a>
		<a
			href={localizeHref('/sources')}
			class="text-sm text-brand-700 underline decoration-brand-700/30 underline-offset-2 hover:decoration-current"
			>{m.nav_sources()} →</a
		>
	</div>
</div>
