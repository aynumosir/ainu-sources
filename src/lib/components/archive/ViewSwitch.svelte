<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import BilingualLabel from './BilingualLabel.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';

	type LibraryView = 'cards' | 'list';

	const options: { value: LibraryView; label: { ja: string; en: string } }[] = [
		{ value: 'cards', label: archiveLabels.cardsView },
		{ value: 'list', label: archiveLabels.listView }
	];

	const current = $derived<LibraryView>(
		page.url.searchParams.get('view') === 'list' ? 'list' : 'cards'
	);

	function select(value: LibraryView) {
		if (value === current) return;
		const params = new URLSearchParams(page.url.searchParams);
		if (value === 'cards') params.delete('view');
		else params.set('view', value);
		const qs = params.toString();
		goto(qs ? `?${qs}` : page.url.pathname, { replaceState: true, keepFocus: true, noScroll: true });
	}
</script>

<div
	class="archive-view-switch inline-flex border border-[var(--archive-border)] bg-[var(--archive-panel)]"
	role="group"
	aria-label={bilingualAriaLabel(archiveLabels.view)}
>
	{#each options as opt (opt.value)}
		<button
			type="button"
			class="relative px-3 py-1.5 text-[12px] font-semibold transition-colors"
			class:is-on={current === opt.value}
			aria-pressed={current === opt.value}
			onclick={() => select(opt.value)}
		>
			<BilingualLabel ja={opt.label.ja} en={opt.label.en} compact />
		</button>
	{/each}
</div>

<style>
	.archive-view-switch button {
		color: var(--archive-subtle);
	}
	.archive-view-switch button:hover {
		color: var(--archive-text);
	}
	.archive-view-switch button.is-on {
		background: var(--archive-paper);
		color: var(--archive-gilt-text);
		box-shadow: inset 0 -2px 0 0 var(--archive-gilt);
	}
	.archive-view-switch button + button {
		border-left: 1px solid var(--archive-border);
	}
	.archive-view-switch button:focus-visible {
		outline: 2px solid var(--archive-gilt);
		outline-offset: -2px;
	}
</style>
