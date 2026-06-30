<script lang="ts">
	import { localizeHref, getLocale } from '$lib/paraglide/runtime';
	import Seo from '$lib/components/Seo.svelte';
	import { kindBadge, statusBadge } from '$lib/review-ui';
	import type { PageData } from './$types';

	let { data } = $props();

	function when(ms: number): string {
		return new Date(ms).toLocaleString(getLocale(), {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}

	/** A compact one-line summary of what the proposal changes. */
	function oneLine(item: PageData['items'][number]): string {
		const lines = item.diff?.summaryLines ?? [];
		if (lines.length) return lines.slice(0, 2).join('  ·  ') + (lines.length > 2 ? ' …' : '');
		const sc = item.diff?.changedScalarFields?.length ?? 0;
		const cc = item.diff?.changedCollections?.length ?? 0;
		if (sc || cc) return `${sc} field${sc === 1 ? '' : 's'}, ${cc} collection${cc === 1 ? '' : 's'} changed`;
		return 'No content fields changed (metadata only).';
	}

	const pct = (c: number) => `${Math.round(c * 100)}%`;
</script>

<Seo title="Review queue" description="Moderator review of proposed catalogue changes." noindex />

<div class="mx-auto max-w-4xl px-4 py-8">
	<div class="flex flex-wrap items-baseline justify-between gap-2">
		<h1 class="font-serif text-3xl font-bold text-ink">Review queue</h1>
		<span class="text-sm text-stone-500">
			{data.items.length} open proposal{data.items.length === 1 ? '' : 's'}
		</span>
	</div>
	<p class="mt-1 max-w-2xl text-sm text-stone-500">
		Proposed changes the merge engine routed to review instead of auto-applying — new
		sources, low-trust enrichments, and conflicts. Approving runs the proposal through the
		same merge pipeline; a verdict gates application, it never changes a claim's rank.
	</p>

	{#if data.items.length}
		<ul class="mt-6 space-y-3">
			{#each data.items as item (item.id)}
				{@const k = kindBadge(item.kind)}
				{@const s = statusBadge(item.status)}
				<li>
					<a
						href={localizeHref(`/admin/review/${item.id}`)}
						class="block rounded-xl border border-stone-200 bg-paper-card p-4 transition hover:border-brand-300"
					>
						<div class="flex flex-wrap items-center gap-1.5">
							<span class={k.cls}>{k.label}</span>
							<span class={s.cls}>{s.label}</span>
							{#if item.diff?.conflicts?.length}
								<span
									class="inline-flex items-center rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-800"
									>{item.diff.conflicts.length} conflict{item.diff.conflicts.length === 1
										? ''
										: 's'}</span
								>
							{/if}
							<span class="ml-auto tnum text-xs text-stone-400">{when(item.createdAt)}</span>
						</div>

						<h2 class="mt-2 font-serif text-lg font-semibold text-ink">
							{item.title || '(untitled proposal)'}
						</h2>

						<p class="mt-1 text-sm text-stone-600">{oneLine(item)}</p>

						<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
							<span><span class="text-stone-400">via</span> {item.origin}</span>
							<span class="font-mono">{item.derivation}</span>
							<span class="tnum">conf {pct(item.confidence)}</span>
							<span class="font-mono text-stone-400">{item.routingReason}</span>
						</div>
					</a>
				</li>
			{/each}
		</ul>
	{:else}
		<p
			class="mt-6 rounded-xl border border-dashed border-stone-300 p-10 text-center text-sm text-stone-500"
		>
			No proposals awaiting review ✓
		</p>
	{/if}
</div>
