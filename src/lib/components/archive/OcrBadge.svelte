<script lang="ts">
	type OcrCoverage = { status?: string; variant?: string; preferred?: boolean } | null;
	let { coverage }: { coverage?: OcrCoverage } = $props();
</script>

{#if coverage}
	<span class="bg-[var(--archive-accent-soft)] px-2 py-0.5 text-[13px] font-medium text-[var(--archive-gilt-text)]">
		OCR {coverage.variant ?? coverage.status ?? 'available'}
	</span>
{/if}
