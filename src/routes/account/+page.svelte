<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Seo from '$lib/components/Seo.svelte';

	let { data } = $props();
</script>

<Seo title={`${m.auth_account()} · ${m.site_short()}`} noindex />

<div class="mx-auto max-w-2xl px-4 py-12">
	<h1 class="font-serif text-3xl font-bold text-ink">{m.auth_account()}</h1>
	<div class="mt-6 rounded-xl border border-stone-200 bg-paper-card p-6">
		<p class="text-stone-700">{m.auth_logged_in_as({ name: data.user.name })}</p>
		<p class="mt-1 text-sm text-stone-500">{data.user.email}</p>

		<div class="mt-6 flex flex-wrap items-center gap-3">
			<a
				href={localizeHref('/sources/new')}
				class="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
				>+ {m.new_source_title()}</a
			>
			<form method="POST" action="?/signout" use:enhance>
				<button
					class="rounded-md px-4 py-2 text-sm font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
					>{m.auth_logout()}</button
				>
			</form>
		</div>
	</div>
</div>
