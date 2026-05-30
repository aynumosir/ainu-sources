<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import Header from '$lib/components/Header.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import { m } from '$lib/paraglide/messages.js';

	let { children, data } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>{m.site_title()}</title>
	<meta name="description" content={m.site_description()} />
</svelte:head>

<div class="flex min-h-svh flex-col">
	<Header user={data.user} />
	<main class="flex-1">
		{@render children()}
	</main>
	<Footer />
</div>
