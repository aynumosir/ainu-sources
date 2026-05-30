<script lang="ts">
	import { m } from '$lib/paraglide/messages.js';
	import { localizeHref } from '$lib/paraglide/runtime';
</script>

<svelte:head><title>{m.about_title()} · {m.site_short()}</title></svelte:head>

<article class="mx-auto max-w-3xl px-4 py-10">
	<header class="space-y-6">
		<h1 class="font-serif text-4xl font-bold text-ink">{m.about_title()}</h1>
		<p class="text-lg leading-relaxed text-stone-700">{m.about_intro()}</p>
	</header>

	<div class="mt-10 space-y-10">
		<section class="space-y-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.about_purpose_h()}</h2>
			<p class="leading-relaxed text-stone-700">{m.about_purpose_p()}</p>
		</section>

		<section class="space-y-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.about_scope_h()}</h2>
			<p class="leading-relaxed text-stone-700">{m.about_scope_p()}</p>
		</section>

		<section class="space-y-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.about_model_h()}</h2>
			<p class="leading-relaxed text-stone-700">{m.about_model_p()}</p>
		</section>

		<section class="space-y-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.about_data_h()}</h2>
			<p class="leading-relaxed text-stone-700">{m.about_data_p()}</p>
		</section>

		<section class="space-y-3">
			<h2 class="font-serif text-2xl font-bold text-ink">{m.about_contribute_h()}</h2>
			<p class="leading-relaxed text-stone-700">{m.about_contribute_p()}</p>
		</section>
	</div>

	<div class="mt-12 flex flex-wrap gap-3 border-t border-stone-200 pt-8">
		<a
			href={localizeHref('/sources')}
			class="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
			>{m.home_browse_cta()}</a
		>
		<a
			href={localizeHref('/timeline')}
			class="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-ink hover:bg-paper-card"
			>{m.home_explore_timeline()}</a
		>
	</div>
</article>
