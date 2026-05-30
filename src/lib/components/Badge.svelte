<script lang="ts">
	import {
		tl,
		CATEGORY_LABELS,
		TYPE_LABELS,
		REGION_LABELS,
		CATEGORY_ACCENT
	} from '$lib/constants';

	let {
		kind = 'type',
		value,
		href = undefined
	}: { kind?: 'category' | 'type' | 'region'; value: string; href?: string } = $props();

	const label = $derived(
		kind === 'category'
			? tl(CATEGORY_LABELS, value)
			: kind === 'region'
				? tl(REGION_LABELS, value)
				: tl(TYPE_LABELS, value)
	);
	const cls = $derived(
		kind === 'category'
			? (CATEGORY_ACCENT[value] ?? 'bg-stone-100 text-stone-700 ring-stone-300')
			: 'bg-stone-100 text-stone-600 ring-stone-200'
	);
	const base =
		'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap';
</script>

{#if href}
	<a {href} class="{base} {cls} hover:brightness-95">{label}</a>
{:else}
	<span class="{base} {cls}">{label}</span>
{/if}
