<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Seo from '$lib/components/Seo.svelte';

	let { data, form } = $props();
	const githubLinked = $derived(data.providers.includes('github'));
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

	<!-- Connected accounts -->
	<section class="mt-6 rounded-xl border border-stone-200 bg-paper-card p-6">
		<h2 class="font-serif text-lg font-bold text-ink">{m.account_connections()}</h2>

		{#if form?.message}
			<p class="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
				{form.message}
			</p>
		{/if}

		<ul class="mt-4 divide-y divide-stone-100">
			<!-- Email & password (always present) -->
			<li class="flex items-center gap-3 py-3">
				<svg class="size-5 text-stone-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
					<rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" />
				</svg>
				<span class="flex-1 text-sm text-stone-700">{m.account_password()}</span>
				<span class="text-xs text-emerald-700">{m.account_connected()}</span>
			</li>

			<!-- GitHub -->
			{#if data.githubEnabled || githubLinked}
				<li class="flex items-center gap-3 py-3">
					<svg viewBox="0 0 16 16" class="size-5 text-stone-700" fill="currentColor" aria-hidden="true"
						><path
							d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
						/></svg
					>
					<span class="flex-1 text-sm text-stone-700">GitHub</span>
					{#if githubLinked}
						<span class="text-xs text-emerald-700">{m.account_connected()}</span>
						<form method="POST" action="?/unlinkGithub" use:enhance>
							<button
								class="rounded-md px-3 py-1 text-xs font-medium text-stone-600 ring-1 ring-stone-300 hover:bg-stone-100"
								>{m.account_disconnect()}</button
							>
						</form>
					{:else}
						<form method="POST" action="?/linkGithub" use:enhance>
							<button
								class="rounded-md bg-stone-800 px-3 py-1 text-xs font-medium text-white hover:bg-stone-900"
								>{m.account_connect()}</button
							>
						</form>
					{/if}
				</li>
			{/if}
		</ul>
	</section>
</div>
