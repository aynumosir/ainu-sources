<script lang="ts">
	import './layout.css';
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { locales } from '$lib/paraglide/runtime';
	import { websiteJsonLd, organizationJsonLd, serializeJsonLd } from '$lib/seo';

	let { children } = $props();

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

{@render children()}
