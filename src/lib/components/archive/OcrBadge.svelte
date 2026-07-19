<script lang="ts">
	import { summarizeOcrCoverage, type OcrCoverage } from '$lib/archive/ocr';

	let { coverage = [] }: { coverage?: OcrCoverage[] } = $props();
	const summary = $derived(summarizeOcrCoverage(coverage));
</script>

<span
	class={`whitespace-nowrap px-1.5 py-0.5 text-[12px] font-medium ${
		summary.state === 'available'
			? 'bg-[var(--archive-accent-soft)] text-[var(--archive-gilt-text)]'
			: summary.state === 'partial'
				? 'bg-[var(--archive-panel)] text-[var(--archive-warn)]'
				: 'bg-[var(--archive-muted)] text-[var(--archive-subtle)]'
	}`}
>
	{summary.label}
</span>
