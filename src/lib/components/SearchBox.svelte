<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { value = '', compact = false }: { value?: string; compact?: boolean } = $props();
</script>

<form action={localizeHref('/sources')} method="GET" role="search" class="relative {compact ? 'w-full' : 'w-full max-w-md'}">
	<svg
		class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400"
		viewBox="0 0 20 20"
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		aria-hidden="true"
	>
		<circle cx="9" cy="9" r="6" />
		<path d="m18 18-4.5-4.5" stroke-linecap="round" />
	</svg>
	<input
		type="search"
		name="q"
		{value}
		placeholder={m.nav_search_placeholder()}
		class="w-full rounded-full border-stone-300 bg-white py-1.5 pl-9 pr-3 text-sm shadow-sm focus:border-brand-600 focus:ring-brand-600"
		aria-label={m.common_search()}
	/>
</form>
