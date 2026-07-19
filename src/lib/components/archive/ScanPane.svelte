<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onDestroy } from 'svelte';
	import { archiveFetch } from '$lib/archive/session.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';

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
		boxes?: BboxOverlay;
		overlay?: Snippet<[BboxOverlay | undefined]>;
		onpage: (page: number) => void;
		onthumbnail?: (src: string | null) => void;
	} = $props();

	let lowSrc = $state<string | null>(null);
	let highSrc = $state<string | null>(null);
	let outgoingSrc = $state<string | null>(null);
	let loading = $state(true);
	let missing = $state(false);
	let error = $state<string | null>(null);
	let fit = $state(true);
	let zoom = $state(1);
	let panX = $state(0);
	let panY = $state(0);
	let downloadingOriginal = $state(false);
	let stage: HTMLDivElement | undefined = $state();

	const objectUrls = new Set<string>();
	const cache = new Map<string, string>();
	const pointers = new Map<number, { x: number; y: number }>();
	let dragOrigin = { x: 0, y: 0, panX: 0, panY: 0 };
	let pinchStart = { distance: 0, zoom: 1 };
	let swipeStart = { x: 0, y: 0 };
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

	async function loadPage(scanPage: number): Promise<void> {
		const token = ++requestToken;
		outgoingSrc = highSrc ?? lowSrc;
		onthumbnail?.(null);
		lowSrc = null;
		highSrc = null;
		loading = true;
		missing = false;
		error = null;
		resetView();
		const low = await imageUrl(scanPage, 300);
		if (token !== requestToken) return;
		lowSrc = low;
		onthumbnail?.(low);
		const high = await imageUrl(scanPage, 1200);
		if (token !== requestToken) return;
		highSrc = high;
		loading = false;
		missing = !low && !high;
		setTimeout(() => {
			if (token === requestToken) outgoingSrc = null;
		}, 140);
	}

	function resetView(): void {
		fit = true;
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function setActualSize(): void {
		fit = false;
		zoom = 1;
		panX = 0;
		panY = 0;
	}

	function changeZoom(delta: number, clientX?: number, clientY?: number): void {
		const previous = zoom;
		fit = false;
		zoom = Math.min(4, Math.max(0.35, zoom + delta));
		if (stage && clientX != null && clientY != null && previous !== zoom) {
			const rect = stage.getBoundingClientRect();
			const x = clientX - rect.left - rect.width / 2;
			const y = clientY - rect.top - rect.height / 2;
			const ratio = zoom / previous;
			panX = x - (x - panX) * ratio;
			panY = y - (y - panY) * ratio;
		}
	}

	function wheel(event: WheelEvent): void {
		event.preventDefault();
		changeZoom(event.deltaY < 0 ? 0.12 : -0.12, event.clientX, event.clientY);
	}

	function pointerDown(event: PointerEvent): void {
		stage?.setPointerCapture(event.pointerId);
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.size === 1) {
			dragOrigin = { x: event.clientX, y: event.clientY, panX, panY };
			swipeStart = { x: event.clientX, y: event.clientY };
		}
		if (pointers.size === 2) {
			pinchStart = { distance: pointerDistance(), zoom };
		}
	}

	function pointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.size === 2) {
			fit = false;
			const distance = pointerDistance();
			if (pinchStart.distance > 0) zoom = Math.min(4, Math.max(0.35, pinchStart.zoom * distance / pinchStart.distance));
			return;
		}
		if (!fit) {
			panX = dragOrigin.panX + event.clientX - dragOrigin.x;
			panY = dragOrigin.panY + event.clientY - dragOrigin.y;
		}
	}

	function pointerUp(event: PointerEvent): void {
		const start = swipeStart;
		pointers.delete(event.pointerId);
		if (pointers.size > 0 || !fit) return;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		if (Math.abs(dx) > 54 && Math.abs(dx) > Math.abs(dy)) onpage(page + (dx < 0 ? 1 : -1));
	}

	function pointerDistance(): number {
		const [first, second] = [...pointers.values()];
		return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
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

<section class="scan-pane">
	<header>
		<p class="archive-kicker"><BilingualLabel ja={archiveLabels.scan.ja} en={archiveLabels.scan.en} /></p>
		<span class="tnum">p.{page}</span>
	</header>
	<div
		class="stage"
		bind:this={stage}
		onwheel={wheel}
		onpointerdown={pointerDown}
		onpointermove={pointerMove}
		onpointerup={pointerUp}
		onpointercancel={(event) => pointers.delete(event.pointerId)}
		ondblclick={() => fit ? setActualSize() : resetView()}
		role="application"
		aria-label={`Scan page ${page}. Drag to pan, wheel or pinch to zoom.`}
	>
		{#if outgoingSrc}<img class="page outgoing" src={outgoingSrc} alt="" />{/if}
		{#if lowSrc}<img class:fit class="page low" src={lowSrc} alt="" style={`transform:translate(${panX}px,${panY}px) scale(${zoom})`} />{/if}
		{#if highSrc}<img class:fit class="page high" src={highSrc} alt={`Scan page ${page}`} style={`transform:translate(${panX}px,${panY}px) scale(${zoom})`} />{/if}
		{#if overlay}{@render overlay(boxes)}{/if}
		{#if missing}
			<div class="missing">
				<p>ページ画像を準備中です / Page image is generating.</p>
				<button type="button" onclick={openOriginal} disabled={downloadingOriginal}>PDF / original scan</button>
				{#if error}<p class="error">{error}</p>{/if}
			</div>
		{:else if loading && !lowSrc}
			<div class="skeleton" aria-label="Loading page image"></div>
		{/if}
	</div>
	<footer>
		<button type="button" class:active={fit} onclick={resetView}>fit</button>
		<button type="button" class:active={!fit && zoom === 1} onclick={setActualSize}>100%</button>
		<span class="rule" aria-hidden="true"></span>
		<button type="button" aria-label="Zoom out" onclick={() => changeZoom(-0.15)}>−</button>
		<output>{Math.round(zoom * 100)}%</output>
		<button type="button" aria-label="Zoom in" onclick={() => changeZoom(0.15)}>+</button>
	</footer>
</section>

<style>
	.scan-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--archive-bg); }
	header { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px dotted var(--archive-border); background: var(--archive-paper); padding: 0.55rem 0.8rem; font-size: 12px; color: var(--archive-subtle); }
	.stage { position: relative; display: flex; min-height: 20rem; flex: 1; touch-action: none; align-items: center; justify-content: center; overflow: hidden; padding: 1rem; cursor: grab; user-select: none; }
	.stage:active { cursor: grabbing; }
	.page { position: absolute; display: block; max-width: none; transform-origin: center; border: 1px solid var(--archive-border); background: white; box-shadow: 0 5px 20px rgb(0 0 0 / 20%); pointer-events: none; }
	.page.fit { max-width: calc(100% - 2rem); max-height: calc(100% - 2rem); object-fit: contain; }
	.low { filter: blur(0.45px); }
	.high { opacity: 1; transition: opacity 120ms ease; }
	.outgoing { max-width: calc(100% - 2rem); max-height: calc(100% - 2rem); object-fit: contain; opacity: 0; transition: opacity 120ms ease; }
	.skeleton { width: min(70%, 34rem); height: 80%; border: 1px solid var(--archive-border); background: var(--archive-panel); animation: pulse 1.2s ease-in-out infinite; }
	.missing { border: 1px dashed var(--archive-border); background: var(--archive-paper); padding: 1.25rem; text-align: center; font-size: 13px; color: var(--archive-subtle); }
	.missing button { margin-top: 0.7rem; color: var(--archive-gilt-text); }
	.error { margin-top: 0.5rem; color: var(--archive-danger); }
	footer { display: flex; align-items: center; gap: 0.35rem; border-top: 1px solid var(--archive-border); background: var(--archive-paper); padding: 0.45rem 0.7rem; font-size: 12px; }
	footer button { min-width: 2rem; border: 1px solid transparent; padding: 0.25rem 0.4rem; color: var(--archive-subtle); }
	footer button.active { border-color: var(--archive-gilt); color: var(--archive-gilt-text); }
	footer .rule { width: 1px; height: 1rem; background: var(--archive-border); }
	footer output { min-width: 3rem; text-align: center; color: var(--archive-subtle); }
	@keyframes pulse { 50% { opacity: 0.55; } }
</style>
