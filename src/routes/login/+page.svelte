<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { data, form } = $props();
	const inputCls =
		'mt-1 w-full rounded-md border-stone-300 bg-white text-sm shadow-sm focus:border-brand-600 focus:ring-brand-600';
</script>

<svelte:head><title>{m.auth_login()} · {m.site_short()}</title></svelte:head>

<div class="mx-auto flex max-w-sm flex-col px-4 py-12">
	<h1 class="text-center font-serif text-2xl font-bold text-ink">{m.auth_login()}</h1>

	{#if form?.message}
		<p class="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
			{form.message}
		</p>
	{/if}

	<form method="POST" action="?/signin" use:enhance class="mt-6 space-y-4">
		<input type="hidden" name="redirectTo" value={data.redirectTo} />
		<label class="block">
			<span class="text-sm font-medium text-stone-600">{m.auth_email()}</span>
			<input type="email" name="email" required autocomplete="email" class={inputCls} />
		</label>
		<label class="block">
			<span class="text-sm font-medium text-stone-600">{m.auth_password()}</span>
			<input type="password" name="password" required autocomplete="current-password" class={inputCls} />
		</label>
		<button class="w-full rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
			>{m.auth_signin()}</button
		>
	</form>

	<div class="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-stone-400">
		<span class="h-px flex-1 bg-stone-200"></span>{m.auth_or()}<span class="h-px flex-1 bg-stone-200"></span>
	</div>

	<form method="POST" action="?/github" use:enhance>
		<input type="hidden" name="redirectTo" value={data.redirectTo} />
		<button
			class="flex w-full items-center justify-center gap-2 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50"
		>
			<svg viewBox="0 0 16 16" class="size-4" fill="currentColor" aria-hidden="true"
				><path
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"
				/></svg
			>
			{m.auth_signin_github()}
		</button>
	</form>

	<p class="mt-6 text-center text-sm text-stone-500">
		<a href={localizeHref('/register')} class="link">{m.auth_no_account()}</a>
	</p>
</div>
