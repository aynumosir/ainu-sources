<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import { archiveFetch } from '$lib/archive/session.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';
	import ScanViewer from './ScanViewer.svelte';

	export type BboxOverlay = {
		page: number;
		rects: { x: number; y: number; w: number; h: number; block: number }[];
	};

	let {
		revisionId,
		page,
		pageCount,
		boxes,
		overlay,
		onpage,
		onthumbnail
	}: {
		revisionId: string;
		page: number;
		pageCount: number;
		/** Rects in fractions of the page's own size, drawn on the page itself:
		 * they scale, pan and rotate with the scan rather than with the pane. */
		boxes?: BboxOverlay;
		overlay?: Snippet<[BboxOverlay | undefined]>;
		onpage: (page: number) => void;
		onthumbnail?: (src: string | null) => void;
	} = $props();

	let lowSrc = $state<string | null>(null);
	let highSrc = $state<string | null>(null);
	let loading = $state(true);
	let missing = $state(false);
	let error = $state<string | null>(null);
	let downloadingOriginal = $state(false);
	let paneEl: HTMLElement | undefined = $state();

	const objectUrls = new Set<string>();
	const cache = new Map<string, string>();
	let requestToken = 0;

	$effect(() => {
		void loadPage(page);
		for (const nearby of [page - 1, page + 1]) {
			if (nearby >= 1 && nearby <= pageCount) void imageUrl(nearby, 1200);
		}
	});

	onDestroy(() => {
		for (const url of objectUrls) URL.revokeObjectURL(url);
	});

	async function imageUrl(scanPage: number, width: 300 | 1200): Promise<string | null> {
		const key = `${scanPage}:${width}`;
		if (cache.has(key)) return cache.get(key) ?? null;
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revisionId}/pages/${scanPage}.webp?w=${width}`);
			if (!response.ok) {
				return null;
			}
			const url = URL.createObjectURL(await response.blob());
			objectUrls.add(url);
			cache.set(key, url);
			return url;
		} catch {
			return null;
		}
	}

	// The page being left stays on the stage until its successor has decoded, so
	// a page turn never flashes an empty pane.
	async function loadPage(scanPage: number): Promise<void> {
		const token = ++requestToken;
		onthumbnail?.(null);
		loading = true;
		missing = false;
		error = null;
		const low = await imageUrl(scanPage, 300);
		if (token !== requestToken) return;
		if (low) {
			lowSrc = low;
			highSrc = null;
		} else {
			// No preview for this page: the one on screen belongs to the page
			// being left, and the sharp image of that page carries the wait.
			lowSrc = null;
		}
		onthumbnail?.(low);
		const high = await imageUrl(scanPage, 1200);
		if (token !== requestToken) return;
		highSrc = high;
		loading = false;
		missing = !low && !high;
		if (missing) {
			lowSrc = null;
			highSrc = null;
		}
	}

	async function openOriginal(): Promise<void> {
		if (downloadingOriginal) return;
		downloadingOriginal = true;
		error = null;
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revisionId}/content?disposition=inline`);
			if (!response.ok) {
				error = response.status === 404 ? 'Original scan is not yet available.' : `Original scan failed (${response.status}).`;
				return;
			}
			const url = URL.createObjectURL(await response.blob());
			objectUrls.add(url);
			window.open(url, '_blank', 'noopener,noreferrer');
		} finally {
			downloadingOriginal = false;
		}
	}
</script>

{#snippet placeholder()}
	{#if missing}
		<div class="missing">
			<p>ページ画像を準備中です / Page image is generating.</p>
			<button type="button" onclick={openOriginal} disabled={downloadingOriginal}>PDF / original scan</button>
			{#if error}<p class="error">{error}</p>{/if}
		</div>
	{:else if loading}
		<div class="skeleton" aria-label="Loading page image"></div>
	{/if}
{/snippet}

{#snippet viewerOverlay()}
	{#if overlay}{@render overlay(boxes)}{/if}
{/snippet}

<section class="scan-pane" bind:this={paneEl}>
	<header>
		<p class="archive-kicker"><BilingualLabel ja={archiveLabels.scan.ja} en={archiveLabels.scan.en} /></p>
		<span class="tnum">p.{page}</span>
	</header>
	<ScanViewer
		src={highSrc}
		previewSrc={lowSrc}
		alt={`Scan page ${page}`}
		busy={loading}
		resetKey={page}
		fullscreenTarget={paneEl}
		onturn={(delta) => onpage(page + delta)}
		overlay={overlay ? viewerOverlay : undefined}
		fallback={placeholder}
	/>
</section>

<style>
	.scan-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--archive-bg); }
	header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px dotted var(--archive-border); background: var(--archive-paper); padding: 0.55rem 0.8rem; font-size: 12px; color: var(--archive-subtle); }
	.skeleton { width: min(70%, 34rem); height: 80%; border: 1px solid var(--archive-border); background: var(--archive-panel); animation: pulse 1.2s ease-in-out infinite; }
	.missing { border: 1px dashed var(--archive-border); background: var(--archive-paper); padding: 1.25rem; text-align: center; font-size: 13px; color: var(--archive-subtle); }
	.missing button { margin-top: 0.7rem; color: var(--archive-gilt-text); }
	.error { margin-top: 0.5rem; color: var(--archive-danger); }
	@keyframes pulse { 50% { opacity: 0.55; } }
</style>
