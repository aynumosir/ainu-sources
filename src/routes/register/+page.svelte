<script lang="ts">
	import { enhance } from '$app/forms';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { data, form } = $props();
	const inputCls =
		'mt-1 w-full rounded-md border-stone-300 bg-white text-sm shadow-sm focus:border-brand-600 focus:ring-brand-600';
</script>

<svelte:head><title>{m.auth_register()} · {m.site_short()}</title></svelte:head>

<div class="mx-auto flex max-w-sm flex-col px-4 py-12">
	<h1 class="text-center font-serif text-2xl font-bold text-ink">{m.auth_signup()}</h1>

	{#if form?.message}
		<p class="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
			{form.message}
		</p>
	{/if}

	<form method="POST" use:enhance class="mt-6 space-y-4">
		<input type="hidden" name="redirectTo" value={data.redirectTo} />
		<label class="block">
			<span class="text-sm font-medium text-stone-600">{m.auth_name()}</span>
			<input name="name" autocomplete="name" class={inputCls} />
		</label>
		<label class="block">
			<span class="text-sm font-medium text-stone-600">{m.auth_email()}</span>
			<input type="email" name="email" required autocomplete="email" class={inputCls} />
		</label>
		<label class="block">
			<span class="text-sm font-medium text-stone-600">{m.auth_password()}</span>
			<input type="password" name="password" required minlength="8" autocomplete="new-password" class={inputCls} />
		</label>
		<button class="w-full rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
			>{m.auth_signup()}</button
		>
	</form>

	<p class="mt-6 text-center text-sm text-stone-500">
		<a href={localizeHref('/login')} class="link">{m.auth_have_account()}</a>
	</p>
</div>
