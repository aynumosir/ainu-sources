<script lang="ts">
	import { localizeHref, getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { data } = $props();

	function when(d: Date | string | number): string {
		const date = d instanceof Date ? d : new Date(d);
		return date.toLocaleString(getLocale(), {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
	const actionLabel = (a: string) =>
		a === 'create' ? m.history_action_create() : m.history_action_update();
</script>

<svelte:head><title>{m.history_title()} · {data.source.title}</title></svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
	<a href={localizeHref(`/sources/${data.source.slug}`)} class="text-sm text-stone-500 hover:text-brand-700"
		>← {data.source.title}</a
	>
	<h1 class="mt-2 font-serif text-3xl font-bold text-ink">{m.history_title()}</h1>

	{#if data.revisions.length}
		<ol class="mt-6 space-y-4 border-l-2 border-stone-200 pl-5">
			{#each data.revisions as r (r.id)}
				<li class="relative">
					<span
						class="absolute -left-[1.55rem] top-1.5 size-3 rounded-full ring-2 ring-paper {r.action ===
						'create'
							? 'bg-emerald-500'
							: 'bg-brand-600'}"
					></span>
					<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
						<span class="font-medium text-ink">{actionLabel(r.action)}</span>
						<span class="text-stone-500">{m.history_by()} {r.userName || m.history_anonymous()}</span>
						<span class="tnum text-stone-400">· {when(r.createdAt)}</span>
					</div>
					{#if r.summary}<p class="mt-0.5 text-sm text-stone-600">{r.summary}</p>{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="mt-6 text-stone-500">{m.history_none()}</p>
	{/if}
</div>
