<script lang="ts">
	import './layout.css';
	import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { locales } from '$lib/paraglide/runtime';
	import { websiteJsonLd, organizationJsonLd, serializeJsonLd } from '$lib/seo';

	let { children, data } = $props();

	// Site-wide structured data (WebSite + Organization). Page-level entity
	// markup is emitted by each page's <Seo> component.
	const origin = $derived(page.url.origin);
	const globalJsonLd = $derived([
		websiteJsonLd({
			origin,
			name: m.site_title(),
			description: m.site_description(),
			inLanguage: [...locales]
		}),
		organizationJsonLd({ origin, name: m.site_title(), description: m.footer_tagline() })
	]);
</script>

<svelte:head>
	{#each globalJsonLd as obj, i (i)}
		{@html '<script type="application/ld+json">' + serializeJsonLd(obj) + '<\/script>'}
	{/each}
</svelte:head>

<div class="flex min-h-svh flex-col">
	<Header user={data.user} />
	<main class="flex-1">
		{@render children()}
	</main>
	<Footer />
</div>
