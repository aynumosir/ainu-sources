<script lang="ts">
	import { page } from '$app/state';
	import { locales, localizeHref, getLocale } from '$lib/paraglide/runtime';

	const names: Record<string, string> = { en: 'EN', ja: '日本語', ru: 'Русский', ain: 'Aynu' };
	const current = $derived(getLocale());
</script>

<div class="flex items-center gap-0.5 text-xs" aria-label="Language">
	{#each locales as l (l)}
		<a
			href={localizeHref(page.url.pathname + page.url.search, { locale: l })}
			data-active={l === current}
			data-sveltekit-reload
			class="rounded px-1.5 py-1 text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 data-[active=true]:font-semibold data-[active=true]:text-stone-900"
			>{names[l] ?? l}</a
		>
	{/each}
</div>
