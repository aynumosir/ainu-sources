<script lang="ts">
	import type { Snippet } from 'svelte';
	import { onMount, untrack } from 'svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import { prefersReducedMotion } from '$lib/archive/motion';
	import {
		clamp,
		clampOffset,
		fitScale,
		nextRotation,
		offsetAfterZoom,
		panBounds,
		scaleBounds,
		scaleForNewContent,
		wheelZoomFactor,
		type FitMode,
		type Point,
		type Rotation,
		type Size
	} from '$lib/archive/viewport';

	let {
		src,
		previewSrc = null,
		alt,
		resetKey = null,
		fullscreenTarget = undefined,
		onturn = undefined,
		overlay = undefined,
		fallback = undefined
	}: {
		/** Sharpest page image available; null while it loads. */
		src: string | null;
		/** Smaller derivative to paint until `src` decodes. */
		previewSrc?: string | null;
		alt: string;
		/** Changing this recentres the page — the page number, normally. */
		resetKey?: unknown;
		/** Element to send fullscreen, where the host wraps the viewer in its own chrome. */
		fullscreenTarget?: HTMLElement;
		/** Swipe and edge-tap page turns; −1 back, +1 forward. */
		onturn?: (delta: number) => void;
		overlay?: Snippet;
		/** Drawn centred when there is no image: loading, missing, over quota. */
		fallback?: Snippet;
	} = $props();

	/** Breathing room kept around a fitted page, in CSS pixels. */
	const STAGE_MARGIN = 16;
	/** Height the control rail occupies at the foot of the stage. */
	const RAIL_BAND = 52;
	const BUTTON_ZOOM_STEP = 1.35;
	const KEY_PAN_STEP = 64;
	const SWIPE_DISTANCE = 54;
	const TAP_SLOP = 8;
	const TAP_DURATION = 400;

	let root: HTMLDivElement | undefined = $state();
	let stageEl: HTMLDivElement | undefined = $state();
	let stage = $state<Size>({ width: 0, height: 0 });
	let content = $state<Size>({ width: 0, height: 0 });
	let scale = $state(1);
	let offset = $state<Point>({ x: 0, y: 0 });
	let rotation = $state<Rotation>(0);
	let mode = $state<FitMode | 'free'>('page');
	let smooth = $state(false);
	let fullscreen = $state(false);
	let fullscreenAvailable = $state(false);
	let measuredSharp = false;

	const pointers = new Map<number, Point>();
	let drag = { x: 0, y: 0, offset: { x: 0, y: 0 } };
	let pinch = { distance: 0, scale: 1, offset: { x: 0, y: 0 }, anchor: { x: 0, y: 0 } };
	let tap = { x: 0, y: 0, at: 0, pointerType: 'mouse' };
	let pinched = false;

	// The page is laid out against the stage minus its margins and the band the
	// rail sits in, so a fitted page is never covered by its own controls.
	const view = $derived({
		width: Math.max(0, stage.width - STAGE_MARGIN * 2),
		height: Math.max(0, stage.height - STAGE_MARGIN * 2 - RAIL_BAND)
	});
	const viewShiftY = $derived(-RAIL_BAND / 2);
	const measured = $derived(content.width > 0 && stage.width > 0);
	const bounds = $derived(scaleBounds(content, view, rotation));
	const reach = $derived(panBounds(content, view, scale, rotation));
	const pannable = $derived(reach.x > 0.5 || reach.y > 0.5);
	const percent = $derived(Math.round(scale * 100));
	const canvasStyle = $derived(
		`width:${content.width}px;height:${content.height}px;` +
			`transform:translate(-50%,-50%) translate(${offset.x}px,${offset.y + viewShiftY}px)` +
			` rotate(${rotation}deg) scale(${scale})`
	);

	// Fit modes are a standing instruction, not a one-off: a resized stage, a
	// quarter turn or a new page recomputes the scale they imply.
	$effect(() => {
		if (!measured) return;
		const fitted = mode === 'free' ? null : fitScale(content, view, rotation, mode);
		untrack(() => {
			if (fitted !== null) scale = fitted;
			offset = clampOffset(offset, content, view, scale, rotation);
		});
	});

	// A page turn returns to the top of the scan and keeps the reader's zoom and
	// orientation.
	$effect(() => {
		void resetKey;
		untrack(() => {
			offset = homeOffset();
			measuredSharp = false;
		});
	});

	onMount(() => {
		fullscreenAvailable = document.fullscreenEnabled;
		const observer = new ResizeObserver(([entry]) => {
			if (entry) stage = { width: entry.contentRect.width, height: entry.contentRect.height };
		});
		if (stageEl) observer.observe(stageEl);
		const keydown = (event: KeyboardEvent) => handleKey(event);
		const fullscreenChange = () => (fullscreen = document.fullscreenElement != null);
		window.addEventListener('keydown', keydown);
		document.addEventListener('fullscreenchange', fullscreenChange);
		return () => {
			observer.disconnect();
			window.removeEventListener('keydown', keydown);
			document.removeEventListener('fullscreenchange', fullscreenChange);
		};
	});

	function measure(event: Event, sharp: boolean): void {
		const image = event.currentTarget as HTMLImageElement;
		const next = { width: image.naturalWidth, height: image.naturalHeight };
		if (!next.width || !next.height) return;
		if (!sharp && measuredSharp) return;
		// A sharper derivative carries more pixels for the same page, so the zoom
		// factor is restated against the new pixel count and the page holds still.
		if (mode === 'free' && content.width > 0) scale = scaleForNewContent(scale, content, next);
		content = next;
		if (sharp) measuredSharp = true;
	}

	function anchorOf(point: { clientX: number; clientY: number }): Point {
		const rect = stageEl?.getBoundingClientRect();
		if (!rect) return { x: 0, y: 0 };
		return {
			x: point.clientX - rect.left - rect.width / 2,
			y: point.clientY - rect.top - rect.height / 2 - viewShiftY
		};
	}

	function zoomTo(target: number, anchor: Point = { x: 0, y: 0 }, animate = false): void {
		if (!measured) return;
		const next = clamp(target, bounds.min, bounds.max);
		if (next === scale) return;
		smooth = animate && !prefersReducedMotion();
		offset = clampOffset(offsetAfterZoom(offset, scale, next, anchor), content, view, next, rotation);
		scale = next;
		mode = 'free';
	}

	function fitTo(next: FitMode): void {
		smooth = !prefersReducedMotion();
		mode = next;
		offset = homeOffset();
	}

	// Fitting the width is for reading, so it starts at the head of the page
	// rather than at its middle.
	function homeOffset(): Point {
		if (mode !== 'width') return { x: 0, y: 0 };
		const fitted = fitScale(content, view, rotation, 'width');
		return { x: 0, y: panBounds(content, view, fitted, rotation).y };
	}

	function actualSize(anchor: Point = { x: 0, y: 0 }): void {
		zoomTo(1, anchor, true);
	}

	function turn(quarterTurns: number): void {
		smooth = !prefersReducedMotion();
		rotation = nextRotation(rotation, quarterTurns);
		offset = { x: 0, y: 0 };
	}

	async function toggleFullscreen(): Promise<void> {
		const target = fullscreenTarget ?? root;
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await target?.requestFullscreen();
		} catch {
			// A browser that refuses the request leaves the page as it is.
		}
	}

	function wheel(event: WheelEvent): void {
		if (!measured) return;
		event.preventDefault();
		smooth = false;
		zoomTo(scale * wheelZoomFactor(event.deltaY, event.deltaMode), anchorOf(event));
	}

	function pointerDown(event: PointerEvent): void {
		try {
			stageEl?.setPointerCapture(event.pointerId);
		} catch {
			// Capture is a convenience for drags that leave the stage; a browser
			// that refuses it still delivers the events.
		}
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		if (pointers.size === 1) {
			drag = { x: event.clientX, y: event.clientY, offset: { ...offset } };
			tap = { x: event.clientX, y: event.clientY, at: Date.now(), pointerType: event.pointerType };
		}
		if (pointers.size === 2) {
			pinched = true;
			pinch = {
				distance: pointerDistance(),
				scale,
				offset: { ...offset },
				anchor: anchorOf(pointerMidpoint())
			};
		}
	}

	function pointerMove(event: PointerEvent): void {
		if (!pointers.has(event.pointerId)) return;
		pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
		smooth = false;
		if (pointers.size >= 2) {
			pinchMove();
			return;
		}
		if (!pannable) return;
		offset = clampOffset(
			{
				x: drag.offset.x + event.clientX - drag.x,
				y: drag.offset.y + event.clientY - drag.y
			},
			content,
			view,
			scale,
			rotation
		);
	}

	function pinchMove(): void {
		const distance = pointerDistance();
		if (pinch.distance <= 0 || distance <= 0) return;
		const anchor = anchorOf(pointerMidpoint());
		const target = clamp((pinch.scale * distance) / pinch.distance, bounds.min, bounds.max);
		const zoomed = offsetAfterZoom(pinch.offset, pinch.scale, target, pinch.anchor);
		offset = clampOffset(
			{ x: zoomed.x + anchor.x - pinch.anchor.x, y: zoomed.y + anchor.y - pinch.anchor.y },
			content,
			view,
			target,
			rotation
		);
		scale = target;
		mode = 'free';
	}

	function pointerUp(event: PointerEvent): void {
		const start = tap;
		pointers.delete(event.pointerId);
		if (pointers.size > 0) return;
		// Lifting the last finger of a pinch travels far enough to read as a
		// swipe, so a pinch ends the gesture rather than turning the page.
		if (pinched) {
			pinched = false;
			return;
		}
		if (!onturn) return;
		const dx = event.clientX - start.x;
		const dy = event.clientY - start.y;
		if (!pannableAcross() && Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
			onturn(dx < 0 ? 1 : -1);
			return;
		}
		// Touch reading turns pages by tapping the page edge; a mouse has the
		// arrow buttons and would only be surprised by a click that moves on.
		if (start.pointerType === 'mouse' || pannable) return;
		if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) return;
		if (Date.now() - start.at > TAP_DURATION) return;
		const rect = stageEl?.getBoundingClientRect();
		if (!rect) return;
		const x = event.clientX - rect.left;
		if (x < rect.width / 4) onturn(-1);
		else if (x > (rect.width * 3) / 4) onturn(1);
	}

	function pointerCancel(event: PointerEvent): void {
		pointers.delete(event.pointerId);
		if (pointers.size === 0) pinched = false;
	}

	function pannableAcross(): boolean {
		return reach.x > 0.5;
	}

	function pointerDistance(): number {
		const [first, second] = [...pointers.values()];
		return first && second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
	}

	function pointerMidpoint(): { clientX: number; clientY: number } {
		const [first, second] = [...pointers.values()];
		if (!first || !second) return { clientX: 0, clientY: 0 };
		return { clientX: (first.x + second.x) / 2, clientY: (first.y + second.y) / 2 };
	}

	function doubleClick(event: MouseEvent): void {
		if (mode === 'free') fitTo('page');
		else actualSize(anchorOf(event));
	}

	function handleKey(event: KeyboardEvent): void {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (isTypingTarget(event.target)) return;
		switch (event.key) {
			case '+':
			case '=':
				event.preventDefault();
				zoomTo(scale * BUTTON_ZOOM_STEP, { x: 0, y: 0 }, true);
				return;
			case '-':
			case '_':
				event.preventDefault();
				zoomTo(scale / BUTTON_ZOOM_STEP, { x: 0, y: 0 }, true);
				return;
			case '0':
				event.preventDefault();
				fitTo('page');
				return;
			case '1':
				event.preventDefault();
				actualSize();
				return;
			case 'w':
				event.preventDefault();
				fitTo('width');
				return;
			case 'r':
				event.preventDefault();
				turn(1);
				return;
			case 'R':
				event.preventDefault();
				turn(-1);
				return;
			case 'F':
			case 'f':
				event.preventDefault();
				void toggleFullscreen();
		}
	}

	// Arrow keys pan the scan while it is under the reader's hands and there is
	// somewhere to pan; otherwise they reach the page-turn shortcuts behind it.
	function stageKey(event: KeyboardEvent): void {
		if (!pannable || event.ctrlKey || event.metaKey || event.altKey) return;
		const step = event.shiftKey ? KEY_PAN_STEP * 3 : KEY_PAN_STEP;
		const move: Record<string, Point> = {
			ArrowLeft: { x: step, y: 0 },
			ArrowRight: { x: -step, y: 0 },
			ArrowUp: { x: 0, y: step },
			ArrowDown: { x: 0, y: -step }
		};
		const delta = move[event.key];
		if (!delta) return;
		const next = clampOffset(
			{ x: offset.x + delta.x, y: offset.y + delta.y },
			content,
			view,
			scale,
			rotation
		);
		if (next.x === offset.x && next.y === offset.y) return;
		event.preventDefault();
		event.stopPropagation();
		smooth = !prefersReducedMotion();
		offset = next;
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		return (
			!!element &&
			(['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable)
		);
	}
</script>

<div class="scan-viewer" bind:this={root} class:fullscreen>
	<!--
		A pan-and-zoom canvas is an application region: it takes the pointer and
		the arrow keys itself, so it carries a role, a tab stop and a spoken hint
		for how it is driven.
	-->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="stage"
		class:grabbable={pannable}
		bind:this={stageEl}
		role="application"
		tabindex="0"
		aria-label={`${alt}. ${bilingualAriaLabel(archiveLabels.viewerHint)}`}
		onwheel={wheel}
		onpointerdown={pointerDown}
		onpointermove={pointerMove}
		onpointerup={pointerUp}
		onpointercancel={pointerCancel}
		ondblclick={doubleClick}
		onkeydown={stageKey}
	>
		<div class="canvas" class:smooth style={canvasStyle}>
			{#if previewSrc}
				<img class="layer" src={previewSrc} alt="" onload={(event) => measure(event, false)} />
			{/if}
			{#if src}
				<img class="layer" {src} {alt} onload={(event) => measure(event, true)} />
			{/if}
			{#if overlay}{@render overlay()}{/if}
		</div>
		{#if fallback && !src && !previewSrc}
			<div class="fallback">{@render fallback()}</div>
		{/if}
	</div>

	<div class="rail" role="toolbar" aria-label={bilingualAriaLabel(archiveLabels.viewerControls)}>
		<button
			type="button"
			onclick={() => zoomTo(scale / BUTTON_ZOOM_STEP, { x: 0, y: 0 }, true)}
			disabled={!measured || scale <= bounds.min}
			title={bilingualAriaLabel(archiveLabels.zoomOut)}
			aria-label={bilingualAriaLabel(archiveLabels.zoomOut)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9" /></svg>
		</button>
		<output class="tnum readout" aria-label={bilingualAriaLabel(archiveLabels.zoomLevel)}
			>{percent}%</output
		>
		<button
			type="button"
			onclick={() => zoomTo(scale * BUTTON_ZOOM_STEP, { x: 0, y: 0 }, true)}
			disabled={!measured || scale >= bounds.max}
			title={bilingualAriaLabel(archiveLabels.zoomIn)}
			aria-label={bilingualAriaLabel(archiveLabels.zoomIn)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h9M8 3.5v9" /></svg>
		</button>

		<span class="rule" aria-hidden="true"></span>

		<button
			type="button"
			onclick={() => fitTo('page')}
			aria-pressed={mode === 'page'}
			class:active={mode === 'page'}
			title={bilingualAriaLabel(archiveLabels.fitPage)}
			aria-label={bilingualAriaLabel(archiveLabels.fitPage)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"
				><path d="M2 2.5h12v11H2zM5.5 5h5v6h-5z" /></svg
			>
		</button>
		<button
			type="button"
			onclick={() => fitTo('width')}
			aria-pressed={mode === 'width'}
			class:active={mode === 'width'}
			title={bilingualAriaLabel(archiveLabels.fitWidth)}
			aria-label={bilingualAriaLabel(archiveLabels.fitWidth)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"
				><path d="M2 3v10M14 3v10M4.5 8h7M6.5 6 4.5 8l2 2M9.5 6l2 2-2 2" /></svg
			>
		</button>
		<button
			type="button"
			onclick={() => actualSize()}
			aria-pressed={mode === 'free' && percent === 100}
			class:active={mode === 'free' && percent === 100}
			title={bilingualAriaLabel(archiveLabels.actualSize)}
			aria-label={bilingualAriaLabel(archiveLabels.actualSize)}
		>
			<span class="glyph">1:1</span>
		</button>

		<span class="rule" aria-hidden="true"></span>

		<button
			type="button"
			onclick={() => turn(-1)}
			title={bilingualAriaLabel(archiveLabels.rotateLeft)}
			aria-label={bilingualAriaLabel(archiveLabels.rotateLeft)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"
				><path d="M3 8a5 5 0 1 0 1.46-3.54M3 2.2V5.5h3.3" /></svg
			>
		</button>
		<button
			type="button"
			onclick={() => turn(1)}
			title={bilingualAriaLabel(archiveLabels.rotateRight)}
			aria-label={bilingualAriaLabel(archiveLabels.rotateRight)}
		>
			<svg viewBox="0 0 16 16" aria-hidden="true"
				><path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.2V5.5H9.7" /></svg
			>
		</button>

		{#if fullscreenAvailable}
			<span class="rule" aria-hidden="true"></span>
			<button
				type="button"
				onclick={() => void toggleFullscreen()}
				aria-pressed={fullscreen}
				title={bilingualAriaLabel(
					fullscreen ? archiveLabels.exitFullscreen : archiveLabels.fullscreen
				)}
				aria-label={bilingualAriaLabel(
					fullscreen ? archiveLabels.exitFullscreen : archiveLabels.fullscreen
				)}
			>
				{#if fullscreen}
					<svg viewBox="0 0 16 16" aria-hidden="true"
						><path d="M2 6h4V2M14 6h-4V2M2 10h4v4M14 10h-4v4" /></svg
					>
				{:else}
					<svg viewBox="0 0 16 16" aria-hidden="true"
						><path d="M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4" /></svg
					>
				{/if}
			</button>
		{/if}
	</div>
</div>

<style>
	.scan-viewer {
		position: relative;
		display: flex;
		min-width: 0;
		min-height: 0;
		flex: 1;
		flex-direction: column;
		background: var(--archive-stage);
	}
	.stage {
		position: relative;
		flex: 1;
		overflow: hidden;
		touch-action: none;
		user-select: none;
	}
	.stage:focus-visible {
		outline: 2px solid var(--archive-gilt);
		outline-offset: -2px;
	}
	.grabbable {
		cursor: grab;
	}
	.grabbable:active {
		cursor: grabbing;
	}
	.canvas {
		position: absolute;
		top: 50%;
		left: 50%;
		transform-origin: center;
		background: white;
		box-shadow: 0 18px 45px -12px rgb(0 0 0 / 65%);
	}
	.canvas.smooth {
		transition: transform 160ms ease-out;
	}
	.layer {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
	}
	.fallback {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		padding: 1rem;
	}
	.rail {
		position: absolute;
		bottom: 0.85rem;
		left: 50%;
		display: flex;
		align-items: center;
		gap: 0.1rem;
		padding: 0.2rem 0.3rem;
		transform: translateX(-50%);
		background: var(--archive-stage-control);
		box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
		backdrop-filter: blur(6px);
	}
	.rail button {
		display: grid;
		width: 2rem;
		height: 2rem;
		border: 1px solid transparent;
		color: var(--archive-text);
		place-items: center;
	}
	.rail button:hover:not(:disabled) {
		color: var(--archive-gilt-text);
	}
	.rail button:disabled {
		opacity: 0.3;
	}
	.rail button.active {
		border-color: var(--archive-gilt);
		color: var(--archive-gilt-text);
	}
	.rail svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-linecap: round;
		stroke-linejoin: round;
		stroke-width: 1.5;
	}
	.glyph {
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.02em;
	}
	.readout {
		min-width: 3rem;
		color: var(--archive-text);
		font-size: 12px;
		text-align: center;
	}
	/* Every control stays reachable on a phone; the rail tightens instead. */
	@media (max-width: 400px) {
		.rail {
			bottom: 0.5rem;
			gap: 0;
			padding: 0.15rem;
		}
		.rail button {
			width: 1.75rem;
			height: 1.75rem;
		}
		.readout {
			min-width: 2.4rem;
			font-size: 11px;
		}
	}
</style>
