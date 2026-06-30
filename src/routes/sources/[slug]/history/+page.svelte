<script lang="ts">
	import { localizeHref, getLocale } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import Seo from '$lib/components/Seo.svelte';
	import type { PageData } from './$types';

	let { data } = $props();

	type Ev = PageData['events'][number];
	type DiffView = NonNullable<Extract<Ev, { kind: 'diff' }>['diff']>;

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

	const opClass = (op: string) =>
		op === 'add' ? 'text-emerald-700' : op === 'clear' ? 'text-rose-700' : 'text-amber-700';
</script>

<Seo title={`${m.history_title()} · ${data.source.title}`} noindex />

<div class="mx-auto max-w-3xl px-4 py-8">
	<a
		href={localizeHref(`/sources/${data.source.slug}`)}
		class="text-sm text-stone-500 hover:text-brand-700">← {data.source.title}</a
	>
	<h1 class="mt-2 font-serif text-3xl font-bold text-ink">{m.history_title()}</h1>

	{#snippet diffCard(diff: DiffView)}
		<div class="mt-2 rounded-lg border border-stone-200 bg-stone-50/60 p-3 text-sm">
			<div class="flex flex-wrap items-center gap-1.5">
				{#if diff.isNewSource}
					<span class="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800"
						>New source</span
					>
				{/if}
				{#if diff.hasConflicts}
					<span class="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800"
						>Conflicts held for review</span
					>
				{/if}
			</div>

			{#if diff.scalars.length}
				<div class="mt-2 overflow-hidden rounded border border-stone-200">
					<table class="w-full border-collapse text-sm">
						<tbody>
							{#each diff.scalars as s (s.field)}
								<tr class="border-b border-stone-100 last:border-0 align-top">
									<td class="w-32 bg-stone-100/70 px-2 py-1 font-mono text-xs text-stone-600"
										>{s.field}</td
									>
									<td class="px-2 py-1">
										<div class="flex flex-wrap items-baseline gap-1.5">
											{#if s.before !== null}
												<span class="text-rose-700 line-through decoration-rose-300"
													>{s.before}</span
												>
											{/if}
											{#if s.before !== null && s.after !== null}
												<span class="text-stone-400">→</span>
											{/if}
											{#if s.after !== null}
												<span class={opClass(s.op)}>{s.after}</span>
											{:else if s.before !== null}
												<span class="text-xs text-stone-400">(cleared)</span>
											{/if}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#each diff.collections as c (c.name)}
				<div class="mt-2">
					<span class="font-mono text-xs text-stone-500">{c.name}</span>
					<ul class="mt-0.5 space-y-0.5">
						{#each c.added as item, i (i)}
							<li class="text-emerald-700"><span class="font-mono">+</span> {item}</li>
						{/each}
						{#each c.removed as item, i (i)}
							<li class="text-rose-700"><span class="font-mono">−</span> {item}</li>
						{/each}
						{#each c.updated as item, i (i)}
							<li class="text-amber-700"><span class="font-mono">~</span> {item}</li>
						{/each}
					</ul>
				</div>
			{/each}

			{#if !diff.scalars.length && !diff.collections.length}
				<p class="mt-1 text-xs text-stone-400">No content fields changed (metadata only).</p>
			{/if}
		</div>
	{/snippet}

	{#if data.events.length}
		<ol class="mt-6 space-y-4 border-l-2 border-stone-200 pl-5">
			{#each data.events as ev (ev.id)}
				<li class="relative">
					{#if ev.kind === 'revision'}
						<span
							class="absolute -left-[1.55rem] top-1.5 size-3 rounded-full ring-2 ring-paper {ev.action ===
							'create'
								? 'bg-emerald-500'
								: 'bg-brand-600'}"
						></span>
						<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
							<span class="font-medium text-ink">{actionLabel(ev.action)}</span>
							<span class="text-stone-500"
								>{m.history_by()} {ev.userName || m.history_anonymous()}</span
							>
							<span class="tnum text-stone-400">· {when(ev.createdAt)}</span>
						</div>
						{#if ev.summary}<p class="mt-0.5 text-sm text-stone-600">{ev.summary}</p>{/if}
						{#if ev.diff}{@render diffCard(ev.diff)}{/if}
					{:else}
						<span
							class="absolute -left-[1.55rem] top-1.5 size-3 rounded-full bg-stone-400 ring-2 ring-paper"
						></span>
						<div class="flex flex-wrap items-baseline gap-x-2 text-sm">
							<span class="font-medium text-ink">Change</span>
							<span class="tnum text-stone-400">· {when(ev.createdAt)}</span>
						</div>
						{@render diffCard(ev.diff)}
					{/if}
				</li>
			{/each}
		</ol>
	{:else}
		<p class="mt-6 text-stone-500">{m.history_none()}</p>
	{/if}
</div>
