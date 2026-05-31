<script lang="ts">
	import { page } from '$app/state';
	import { m } from '$lib/paraglide/messages.js';
	import { deLocalizeUrl } from '$lib/paraglide/runtime';
	import {
		OG_LOCALE,
		OG_IMAGE_PATH,
		OG_IMAGE_W,
		OG_IMAGE_H,
		hreflangAlternates,
		ogAlternateLocales,
		localeOfUrl,
		localizedAbs,
		serializeJsonLd
	} from '$lib/seo';

	interface Props {
		/** Full document title (the page is responsible for any " · Site" suffix). */
		title: string;
		/** Meta description; falls back to the site description. */
		description?: string;
		/** Override the canonical bare path (locale prefix stripped). Defaults to the current path. */
		canonicalPath?: string;
		/** Keep the current query string in the canonical URL (default: drop it). */
		keepQuery?: boolean;
		/** Emit `noindex, nofollow` and suppress hreflang alternates. */
		noindex?: boolean;
		ogType?: 'website' | 'article' | 'profile';
		/** Social image (absolute URL or root-relative path). Defaults to the site card. */
		image?: string;
		imageAlt?: string;
		/** One schema.org object, or several. */
		jsonLd?: unknown;
	}

	let {
		title,
		description,
		canonicalPath,
		keepQuery = false,
		noindex = false,
		ogType = 'website',
		image,
		imageAlt,
		jsonLd
	}: Props = $props();

	const origin = $derived(page.url.origin);
	const currentLocale = $derived(localeOfUrl(page.url));
	const bare = $derived(canonicalPath ?? deLocalizeUrl(page.url).pathname);
	const canonical = $derived(
		localizedAbs(origin, bare, currentLocale) + (keepQuery ? page.url.search : '')
	);
	const alternates = $derived(noindex ? [] : hreflangAlternates(origin, bare));
	const altLocales = $derived(ogAlternateLocales(currentLocale));
	const desc = $derived(description ?? m.site_description());
	const siteName = $derived(m.site_title());
	const imageUrl = $derived(new URL(image ?? OG_IMAGE_PATH, origin).href);
	const robots = $derived(
		noindex
			? 'noindex, nofollow'
			: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
	);
	const jsonLdList = $derived(
		jsonLd == null ? [] : Array.isArray(jsonLd) ? jsonLd : [jsonLd]
	);
</script>

<svelte:head>
	<title>{title}</title>
	<meta name="description" content={desc} />
	<meta name="robots" content={robots} />
	<link rel="canonical" href={canonical} />

	{#each alternates as a (a.hreflang)}
		<link rel="alternate" hreflang={a.hreflang} href={a.href} />
	{/each}

	<!-- Open Graph -->
	<meta property="og:type" content={ogType} />
	<meta property="og:site_name" content={siteName} />
	<meta property="og:title" content={title} />
	<meta property="og:description" content={desc} />
	<meta property="og:url" content={canonical} />
	<meta property="og:locale" content={OG_LOCALE[currentLocale]} />
	{#each altLocales as loc (loc)}
		<meta property="og:locale:alternate" content={loc} />
	{/each}
	<meta property="og:image" content={imageUrl} />
	<meta property="og:image:width" content={String(OG_IMAGE_W)} />
	<meta property="og:image:height" content={String(OG_IMAGE_H)} />
	<meta property="og:image:alt" content={imageAlt ?? siteName} />

	<!-- Twitter -->
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={title} />
	<meta name="twitter:description" content={desc} />
	<meta name="twitter:image" content={imageUrl} />

	<!-- Structured data -->
	{#each jsonLdList as obj, i (i)}
		{@html '<script type="application/ld+json">' + serializeJsonLd(obj) + '<\/script>'}
	{/each}
</svelte:head>
