<script lang="ts">
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import type { RelatedSource } from '$lib/types';

	let {
		related,
		variant = 'catalogue'
	}: {
		related: RelatedSource[];
		variant?: 'catalogue' | 'archive';
	} = $props();

	const citations = $derived(related.filter((item) => item.relation.type === 'cites'));
	const references = $derived(
		citations
			.filter((item) => item.direction === 'out')
			.toSorted(compareRelated)
	);
	const citedBy = $derived(
		citations
			.filter((item) => item.direction === 'in')
			.toSorted(compareRelated)
	);

	function compareRelated(a: RelatedSource, b: RelatedSource): number {
		return (
			(a.source.author ?? '').localeCompare(b.source.author ?? '') ||
			(a.source.yearStart ?? 9999) - (b.source.yearStart ?? 9999) ||
			a.source.title.localeCompare(b.source.title)
		);
	}

	function meta(item: RelatedSource): string {
		return [item.source.author, item.source.yearText ?? item.source.yearStart]
			.filter((value) => value != null && String(value).trim())
			.join(' · ');
	}
</script>

{#snippet list(items: RelatedSource[])}
	<ol class={variant === 'archive' ? 'mt-2 space-y-2 text-[13px]' : 'mt-3 space-y-2 text-sm'}>
		{#each items as item (item.relation.id)}
			<li class={variant === 'archive' ? 'border-l-2 border-[var(--archive-border)] pl-3' : 'pl-4 -indent-4'}>
				<a
					href={localizeHref(`/sources/${item.source.slug}`)}
					class={variant === 'archive'
						? 'text-[var(--archive-gilt-text)] underline decoration-dotted underline-offset-4'
						: 'link'}
				>
					{item.source.title}
				</a>
				{#if meta(item)}
					<span class={variant === 'archive' ? 'block text-[12px] text-[var(--archive-faint-text)]' : 'ml-1 text-xs text-stone-500'}>
						{meta(item)}
					</span>
				{/if}
			</li>
		{/each}
	</ol>
{/snippet}

{#if citations.length}
	{#if variant === 'archive'}
		<section class="border-t border-dotted border-[var(--archive-border)] pt-4">
			<BilingualLabel tag="h3" ja="引用関係" en="Citations" class="archive-h3" />
			{#if references.length}
				<details open={references.length <= 12} class="mt-3">
					<summary class="cursor-pointer font-semibold">
						<BilingualLabel ja="参考文献" en="References" />
						<span class="tnum ml-1 text-[12px] font-normal text-[var(--archive-subtle)]">{references.length}</span>
					</summary>
					{@render list(references)}
				</details>
			{/if}
			{#if citedBy.length}
				<details open={citedBy.length <= 12} class="mt-3">
					<summary class="cursor-pointer font-semibold">
						<BilingualLabel ja="被引用文献" en="Cited by" />
						<span class="tnum ml-1 text-[12px] font-normal text-[var(--archive-subtle)]">{citedBy.length}</span>
					</summary>
					{@render list(citedBy)}
				</details>
			{/if}
		</section>
	{:else}
		<section>
			<h2 class="font-serif text-lg font-bold text-ink">{m.source_citations()}</h2>
			<div class="mt-3 grid gap-6 sm:grid-cols-2">
				{#if references.length}
					<div>
						<h3 class="font-sans text-sm font-semibold text-stone-700">
							{m.source_references()}
							<span class="tnum ml-1 font-normal text-stone-400">{references.length}</span>
						</h3>
						{@render list(references)}
					</div>
				{/if}
				{#if citedBy.length}
					<div>
						<h3 class="font-sans text-sm font-semibold text-stone-700">
							{m.source_cited_by()}
							<span class="tnum ml-1 font-normal text-stone-400">{citedBy.length}</span>
						</h3>
						{@render list(citedBy)}
					</div>
				{/if}
			</div>
		</section>
	{/if}
{/if}
