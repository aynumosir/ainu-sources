<script lang="ts">
	import { page as pageState } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import BilingualLabel from '$lib/components/archive/BilingualLabel.svelte';
	import { archiveFetch, archiveSession } from '$lib/archive/session.svelte';
	import { archiveUsage } from '$lib/archive/usage.svelte';
	import { archiveLabels, bilingualAriaLabel } from '$lib/archive/bilingual-labels';
	import { formatBytes } from '$lib/archive/format';

	type Mode = 'image' | 'pdf';
	type TextEntry =
		| { status: 'idle' | 'loading' }
		| { status: 'ready'; text: string; variant: string }
		| { status: 'unavailable'; message: string }
		| { status: 'error'; message: string };

	let { data }: { data: any } = $props();

	let mounted = $state(false);
	let currentPage = $state(untrack(() => data.initialPage ?? 1));
	let pageField = $state(untrack(() => String(currentPage)));
	let mode = $state<Mode>('image');
	let textPanelOpen = $state(false);
	let panelWidth = $state(360);
	let imageLowSrc = $state<string | null>(null);
	let imageHighSrc = $state<string | null>(null);
	let imageLoading = $state(true);
	let imageMissing = $state(false);
	let modeNotice = $state<string | null>(null);
	let quotaModalOpen = $state(false);
	let takedownNotice = $state<string | null>(null);
	let shortcutHelpOpen = $state(false);
	let overflowOpen = $state(false);
	let findOpen = $state(false);
	let findQuery = $state('');
	let copyStatus = $state<string | null>(null);
	let textCache = $state<Record<number, TextEntry>>({});
	let stageEl: HTMLElement | undefined = $state();
	let dragStartX = 0;
	let dragStartY = 0;
	let draggingPanel = false;

	const objectUrls = new Set<string>();
	const imageCache = new Map<string, string>();

	const pageCount = $derived(data.revision?.pageCount ?? 1);
	const storageKey = $derived(`archive-reader:${data.file?.fileId ?? 'unknown'}`);
	const sourceHref = $derived(`/archive/sources/${data.source?.slug ?? data.slug}`);
	const pageHref = $derived(`/archive/read/${data.source?.slug ?? data.slug}/${data.file?.fileId ?? data.file}?p=${currentPage}`);
	const citationText = $derived(`${data.source?.title ?? data.title}, scan p.${currentPage}\n${pageState.url.origin}${pageHref}`);
	const resetTime = $derived(archiveUsage.value?.resetAt ? new Date(archiveUsage.value.resetAt).toLocaleString('en-US') : 'unknown');
	const selectedText = $derived(textCache[currentPage] ?? { status: 'idle' });

	onMount(() => {
		mounted = true;
		restoreReaderState();
		const keydown = (event: KeyboardEvent) => handleShortcut(event);
		window.addEventListener('keydown', keydown);
		return () => {
			window.removeEventListener('keydown', keydown);
			for (const url of objectUrls) URL.revokeObjectURL(url);
		};
	});

	$effect(() => {
		pageField = String(currentPage);
		if (!mounted) return;
		replacePageParam();
		persistReaderState();
		void loadImagePage(currentPage);
		void loadTextPages(currentPage);
		prefetchImagePages(currentPage);
	});

	$effect(() => {
		if (!mounted) return;
		persistReaderState();
	});

	function restoreReaderState(): void {
		const paramsPage = parsePage(pageState.url.searchParams.get('p'));
		try {
			const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as {
				page?: number;
				mode?: Mode;
				textPanelOpen?: boolean;
				panelWidth?: number;
			};
			mode = saved.mode === 'pdf' || saved.mode === 'image' ? saved.mode : 'image';
			textPanelOpen = !!saved.textPanelOpen;
			if (Number.isFinite(saved.panelWidth)) panelWidth = clamp(Number(saved.panelWidth), 280, Math.floor(window.innerWidth * 0.5));
			currentPage = clampPage(paramsPage ?? saved.page ?? data.initialPage ?? 1);
		} catch {
			currentPage = clampPage(paramsPage ?? data.initialPage ?? 1);
		}
	}

	function persistReaderState(): void {
		localStorage.setItem(
			storageKey,
			JSON.stringify({
				page: currentPage,
				mode,
				textPanelOpen,
				panelWidth
			})
		);
	}

	function replacePageParam(): void {
		const url = new URL(window.location.href);
		url.searchParams.set('p', String(currentPage));
		history.replaceState(history.state, '', url);
	}

	function parsePage(value: string | null): number | null {
		if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}

	function clampPage(page: number): number {
		return clamp(page, 1, pageCount);
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(Math.max(value, min), max);
	}

	function go(delta: number): void {
		currentPage = clampPage(currentPage + delta);
	}

	function jumpToField(): void {
		currentPage = clampPage(Number(pageField) || currentPage);
	}

	function setMode(nextMode: Mode): void {
		mode = nextMode;
		modeNotice = nextMode === 'pdf' ? 'Continuous PDF view is unavailable. Use page image mode.' : null;
	}

	async function readerFetch(input: string): Promise<Response> {
		const response = await archiveFetch(input);
		if (response.status === 429) quotaModalOpen = true;
		if (response.status === 410) takedownNotice = 'This revision has been removed from the archive.';
		if (response.status === 403) {
			const message = await responseMessage(response.clone());
			if (message === 'revision is not readable') {
				archiveSession.accessChanged = false;
				takedownNotice = 'This revision is unavailable under the archive access state.';
			}
		}
		return response;
	}

	async function responseMessage(response: Response): Promise<string | null> {
		try {
			const body = (await response.json()) as { message?: unknown };
			return typeof body.message === 'string' ? body.message : null;
		} catch {
			return null;
		}
	}

	async function imageUrl(scanPage: number, width: 300 | 1200): Promise<string | null> {
		const key = `${scanPage}:${width}`;
		const cached = imageCache.get(key);
		if (cached) return cached;
		const response = await readerFetch(`/api/archive/revisions/${data.revision.id}/pages/${scanPage}.webp?w=${width}`);
		if (!response.ok) return null;
		const url = URL.createObjectURL(await response.blob());
		objectUrls.add(url);
		imageCache.set(key, url);
		return url;
	}

	async function loadImagePage(scanPage: number): Promise<void> {
		if (mode !== 'image' || takedownNotice) return;
		imageLoading = true;
		imageMissing = false;
		const low = await imageUrl(scanPage, 300);
		if (scanPage !== currentPage) return;
		imageLowSrc = low;
		const high = await imageUrl(scanPage, 1200);
		if (scanPage !== currentPage) return;
		imageHighSrc = high;
		imageMissing = !high;
		imageLoading = false;
	}

	function prefetchImagePages(scanPage: number): void {
		for (const next of [scanPage - 1, scanPage + 1]) {
			if (next >= 1 && next <= pageCount) void imageUrl(next, 1200);
		}
	}

	async function loadTextPages(scanPage: number): Promise<void> {
		if (!textPanelOpen) return;
		const pages = [scanPage - 1, scanPage, scanPage + 1].filter((value) => value >= 1 && value <= pageCount);
		const missing = pages.filter((value) => !textCache[value] || textCache[value].status === 'idle');
		if (missing.length === 0) return;
		textCache = { ...textCache, ...Object.fromEntries(missing.map((page) => [page, { status: 'loading' as const }])) };
		const response = await readerFetch(`/api/archive/revisions/${data.revision.id}/text?pages=${missing.join(',')}`);
		if (response.status === 403 || response.status === 410 || response.status === 429) return;
		if (!response.ok) {
			textCache = { ...textCache, ...Object.fromEntries(missing.map((page) => [page, { status: 'error' as const, message: `OCR fetch failed (${response.status}).` }])) };
			return;
		}
		const body = (await response.json()) as
			| { error: 'ocr_unavailable'; alternatives?: unknown[]; note?: string }
			| { revisionId: string; variant: string; pages: { page: number; text: string }[]; nextCursor: string | null };
		if ('error' in body) {
			textCache = { ...textCache, ...Object.fromEntries(missing.map((page) => [page, { status: 'unavailable' as const, message: 'OCR unavailable for this file/page.' }])) };
			return;
		}
		const nextEntries: Record<number, TextEntry> = {};
		for (const requested of missing) nextEntries[requested] = { status: 'unavailable', message: 'OCR unavailable for this file/page.' };
		for (const row of body.pages) nextEntries[row.page] = { status: 'ready', text: row.text, variant: body.variant };
		textCache = { ...textCache, ...nextEntries };
	}

	function toggleTextPanel(): void {
		textPanelOpen = !textPanelOpen;
		if (textPanelOpen) void loadTextPages(currentPage);
	}

	async function copyCitation(): Promise<void> {
		await navigator.clipboard.writeText(citationText);
		copyStatus = 'Copied';
		setTimeout(() => {
			copyStatus = null;
		}, 1500);
	}

	function handleShortcut(event: KeyboardEvent): void {
		if (isTypingTarget(event.target)) return;
		if (event.key === 'ArrowLeft' || event.key === 'k') {
			event.preventDefault();
			go(-1);
		} else if (event.key === 'ArrowRight' || event.key === 'j') {
			event.preventDefault();
			go(1);
		} else if (event.key === 'g') {
			event.preventDefault();
			document.getElementById('reader-page-field')?.focus();
		} else if (event.key === 't') {
			event.preventDefault();
			toggleTextPanel();
		} else if (event.key === 'm') {
			event.preventDefault();
			setMode(mode === 'image' ? 'pdf' : 'image');
		} else if (event.key === 'c') {
			event.preventDefault();
			void copyCitation();
		} else if (event.key === '?') {
			event.preventDefault();
			shortcutHelpOpen = true;
		} else if (event.key === 'f') {
			event.preventDefault();
			void stageEl?.requestFullscreen?.();
		} else if (event.key === '/') {
			event.preventDefault();
			findOpen = true;
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		if (!element) return false;
		return ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable;
	}

	function submitFind(): void {
		if (!findQuery.trim()) return;
		location.href = `/archive/search?q=${encodeURIComponent(findQuery.trim())}&source_slug=${encodeURIComponent(data.source.slug)}`;
	}

	function pointerDown(event: PointerEvent): void {
		dragStartX = event.clientX;
		dragStartY = event.clientY;
	}

	function pointerUp(event: PointerEvent): void {
		const dx = event.clientX - dragStartX;
		const dy = event.clientY - dragStartY;
		if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy)) {
			go(dx < 0 ? 1 : -1);
			return;
		}
		const target = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
		if (!target || Math.abs(dx) > 8 || Math.abs(dy) > 8) return;
		const rect = target.getBoundingClientRect();
		const x = event.clientX - rect.left;
		if (x < rect.width / 3) go(-1);
		if (x > (rect.width * 2) / 3) go(1);
	}

	function startPanelDrag(event: PointerEvent): void {
		draggingPanel = true;
		event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId);
	}

	function dragPanel(event: PointerEvent): void {
		if (!draggingPanel) return;
		panelWidth = clamp(window.innerWidth - event.clientX, 280, Math.floor(window.innerWidth * 0.5));
	}

	function endPanelDrag(): void {
		draggingPanel = false;
	}
</script>

<svelte:head>
	<title>{data.source?.title ?? data.title} - archive reader</title>
</svelte:head>

{#if !data.accessDenied}
	<div class="flex min-h-svh flex-col bg-[var(--archive-bg)] text-[var(--archive-text)]">
		<header class="sticky top-0 z-30 border-b border-dotted border-[var(--archive-border)] bg-[var(--archive-paper)]">
			<div class="flex flex-wrap items-center gap-2 px-3 py-2">
				<a href={sourceHref} class="text-[13px] font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]" aria-label={bilingualAriaLabel(archiveLabels.back)}>
					<BilingualLabel ja={archiveLabels.back.ja} en={archiveLabels.back.en} />
				</a>
				<a href={sourceHref} class="archive-title min-w-0 flex-1 truncate text-[17px] font-semibold text-[var(--archive-text)] hover:text-[var(--archive-gilt-text)]">
					{data.source.title}
				</a>
				{#if data.files.length > 1}
					<label class="flex items-center gap-1 text-[13px] text-[var(--archive-subtle)]">
						<BilingualLabel ja={archiveLabels.file.ja} en={archiveLabels.file.en} />
						<select
							value={data.file.fileId}
							onchange={(event) => {
								const next = event.currentTarget.value;
								if (next) location.href = `/archive/read/${data.source.slug}/${next}?p=1`;
							}}
							class="h-8 max-w-[12rem] border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 text-[13px] text-[var(--archive-text)]"
						>
							{#each data.files as file (file.fileId)}
								<option value={file.fileId}>{file.label ?? file.checkoutPath?.split('/').at(-1) ?? file.role ?? file.fileId}</option>
							{/each}
						</select>
					</label>
				{/if}
				<form
					class="flex items-center gap-1"
					onsubmit={(event) => {
						event.preventDefault();
						jumpToField();
					}}
				>
					<input
						id="reader-page-field"
						inputmode="numeric"
						bind:value={pageField}
						class="tnum h-8 w-16 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 text-center text-[13px] text-[var(--archive-text)]"
						aria-label="Page"
					/>
					<span class="tnum text-[13px] text-[var(--archive-subtle)]">/ {pageCount}</span>
				</form>
				<div class="flex border border-[var(--archive-border)] text-[13px]">
					<button
						type="button"
						aria-label={bilingualAriaLabel(archiveLabels.imageMode)}
						onclick={() => setMode('image')}
						class={`px-2 py-1 ${mode === 'image' ? 'bg-[var(--archive-gilt)] text-[var(--archive-paper)]' : 'bg-[var(--archive-paper)] text-[var(--archive-subtle)]'}`}
					>
						<BilingualLabel ja={archiveLabels.imageMode.ja} en={archiveLabels.imageMode.en} inverse={mode === 'image'} />
					</button>
					<button
						type="button"
						aria-label={bilingualAriaLabel(archiveLabels.pdfMode)}
						onclick={() => setMode('pdf')}
						class={`border-l border-[var(--archive-border)] px-2 py-1 ${mode === 'pdf' ? 'bg-[var(--archive-gilt)] text-[var(--archive-paper)]' : 'bg-[var(--archive-paper)] text-[var(--archive-subtle)]'}`}
					>
						<BilingualLabel ja={archiveLabels.pdfMode.ja} en={archiveLabels.pdfMode.en} inverse={mode === 'pdf'} />
					</button>
				</div>
				<button
					type="button"
					aria-label={bilingualAriaLabel(archiveLabels.textPanel)}
					onclick={toggleTextPanel}
					class={`border px-2 py-1 text-[13px] ${textPanelOpen ? 'border-[var(--archive-gilt)] bg-[var(--archive-panel)] text-[var(--archive-text)]' : 'border-[var(--archive-border)] bg-[var(--archive-paper)] text-[var(--archive-subtle)]'}`}
				>
					<BilingualLabel ja={archiveLabels.textPanel.ja} en={archiveLabels.textPanel.en} />
				</button>
				<div class="relative">
					<button
						type="button"
						aria-label="Reader menu"
						onclick={() => (overflowOpen = !overflowOpen)}
						class="h-8 w-8 border border-[var(--archive-border)] bg-[var(--archive-paper)] text-[17px] hover:border-[var(--archive-gilt)]"
					>
						<span aria-hidden="true">⋯</span>
					</button>
					{#if overflowOpen}
						<div class="absolute right-0 mt-2 w-64 border border-[var(--archive-border)] bg-[var(--archive-paper)] p-3 text-[13px] shadow-lg">
							<button type="button" class="block w-full py-1 text-left text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]" onclick={copyCitation}>
								<BilingualLabel ja={archiveLabels.copyCitation.ja} en={archiveLabels.copyCitation.en} />
							</button>
							<a href={`/api/archive/revisions/${data.revision.id}/content?disposition=attachment`} target="_blank" rel="noreferrer" class="block py-1 text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">
								<BilingualLabel ja={archiveLabels.download.ja} en={archiveLabels.download.en} />
								<span class="ml-1 text-[var(--archive-subtle)]">{formatBytes(data.revision.bytes)}</span>
							</a>
							<button type="button" class="block w-full py-1 text-left text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]" onclick={() => (shortcutHelpOpen = true)}>
								<BilingualLabel ja={archiveLabels.shortcuts.ja} en={archiveLabels.shortcuts.en} />
							</button>
							<p class="mt-3 border-t border-dotted border-[var(--archive-border)] pt-3 text-[12px] leading-5 text-[var(--archive-faint-text)]">
								aynumosir archive - private research collection · access is audited
							</p>
						</div>
					{/if}
				</div>
			</div>
		</header>

		{#if modeNotice}
			<p class="border-b border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 py-2 text-[13px] text-[var(--archive-subtle)]">{modeNotice}</p>
		{/if}
		{#if copyStatus}
			<p class="fixed right-3 top-14 z-40 border border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-[13px] text-[var(--archive-text)] shadow-sm">{copyStatus}</p>
		{/if}

		<div class="reader-grid flex min-h-0 flex-1" style={`--reader-panel-width:${panelWidth}px`}>
			<main class="relative min-w-0 flex-1" bind:this={stageEl}>
				<div class="absolute inset-y-0 left-2 z-10 flex items-center">
					<button type="button" aria-label={bilingualAriaLabel(archiveLabels.previousPage)} onclick={() => go(-1)} class="h-12 w-8 border border-[var(--archive-border)] bg-[var(--archive-paper)]/90 text-[17px] hover:border-[var(--archive-gilt)]">‹</button>
				</div>
				<div class="absolute inset-y-0 right-2 z-10 flex items-center">
					<button type="button" aria-label={bilingualAriaLabel(archiveLabels.nextPage)} onclick={() => go(1)} class="h-12 w-8 border border-[var(--archive-border)] bg-[var(--archive-paper)]/90 text-[17px] hover:border-[var(--archive-gilt)]">›</button>
				</div>
				<section
					role="application"
					class="flex h-full min-h-[calc(100svh-4rem)] touch-pan-y items-center justify-center overflow-auto bg-[var(--archive-bg)] p-4"
					onpointerdown={pointerDown}
					onpointerup={pointerUp}
				>
					{#if takedownNotice}
						<div class="max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 text-center text-[15px] text-[var(--archive-subtle)]">{takedownNotice}</div>
					{:else if mode === 'pdf'}
						<div class="max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 text-center">
							<BilingualLabel ja={archiveLabels.pdfMode.ja} en={archiveLabels.pdfMode.en} class="text-[17px] font-semibold" />
							<p class="mt-3 text-[15px] leading-7 text-[var(--archive-subtle)]">Continuous PDF view is unavailable. Use page image mode.</p>
						</div>
					{:else}
						<div class="relative max-h-full max-w-full">
							{#if imageLowSrc && !imageHighSrc}
								<img src={imageLowSrc} alt="" class="max-h-[calc(100svh-7rem)] max-w-full blur-sm" />
							{/if}
							{#if imageHighSrc}
								<img src={imageHighSrc} alt={`Scan page ${currentPage}`} class="max-h-[calc(100svh-7rem)] max-w-full border border-[var(--archive-border)] bg-white shadow-sm" />
							{:else if imageMissing}
								<div class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-8 text-center text-[15px] text-[var(--archive-subtle)]">
									Page image is generating. Try this page again shortly.
								</div>
							{:else if imageLoading}
								<div class="h-[70svh] w-[min(70vw,42rem)] animate-pulse border border-[var(--archive-border)] bg-[var(--archive-paper)]"></div>
							{/if}
						</div>
					{/if}
				</section>
			</main>

			{#if textPanelOpen}
				<div
					role="separator"
					aria-orientation="vertical"
					class="reader-divider hidden w-1 cursor-col-resize bg-[var(--archive-border)] md:block"
					onpointerdown={startPanelDrag}
					onpointermove={dragPanel}
					onpointerup={endPanelDrag}
					onpointercancel={endPanelDrag}
				></div>
				<aside class="reader-text-panel border-l border-[var(--archive-border)] bg-[var(--archive-paper)] p-4">
					<div class="flex items-center justify-between gap-2 border-b border-dotted border-[var(--archive-border)] pb-2">
						<p class="archive-kicker">OCR text · p.{currentPage}</p>
						<button type="button" class="text-[13px] text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]" onclick={() => (textPanelOpen = false)}>Close</button>
					</div>
					<div class="mt-4 font-[var(--font-archive-serif)] text-[17px] leading-8">
						{#if selectedText.status === 'ready'}
							<p class="archive-kicker mb-2">variant · {selectedText.variant}</p>
							<pre class="whitespace-pre-wrap break-words font-[var(--font-archive-serif)]">{selectedText.text}</pre>
						{:else if selectedText.status === 'loading'}
							<p class="text-[15px] text-[var(--archive-subtle)]">Loading OCR text...</p>
						{:else if selectedText.status === 'unavailable'}
							<p class="text-[15px] text-[var(--archive-subtle)]">{selectedText.message}</p>
						{:else if selectedText.status === 'error'}
							<p class="text-[15px] text-[var(--archive-danger)]">{selectedText.message}</p>
						{:else}
							<p class="text-[15px] text-[var(--archive-subtle)]">Loading OCR text...</p>
						{/if}
					</div>
				</aside>
			{/if}
		</div>
	</div>

	{#if quotaModalOpen}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
			<div class="max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 text-[15px] shadow-lg">
				<h2 class="text-[17px] font-semibold">Archive stream limit reached</h2>
				<p class="mt-3 leading-7 text-[var(--archive-subtle)]">The daily byte budget or stream limit is exhausted. Reset time: {resetTime}.</p>
				<button type="button" class="mt-4 border border-[var(--archive-border)] px-3 py-2 text-[13px] hover:border-[var(--archive-gilt)]" onclick={() => (quotaModalOpen = false)}>Close</button>
			</div>
		</div>
	{/if}

	{#if shortcutHelpOpen}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
			<div class="max-w-lg border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 text-[15px] shadow-lg">
				<BilingualLabel tag="h2" ja={archiveLabels.shortcuts.ja} en={archiveLabels.shortcuts.en} class="text-[17px] font-semibold" />
				<dl class="mt-4 grid grid-cols-[5rem_1fr] gap-2 text-[13px]">
					<dt class="archive-mono">← → / k j</dt><dd>Previous or next page</dd>
					<dt class="archive-mono">g</dt><dd>Focus page field</dd>
					<dt class="archive-mono">t</dt><dd>Toggle OCR text</dd>
					<dt class="archive-mono">m</dt><dd>Toggle render mode</dd>
					<dt class="archive-mono">c</dt><dd>Copy citation</dd>
					<dt class="archive-mono">/</dt><dd>Open in-book search handoff</dd>
					<dt class="archive-mono">f</dt><dd>Fullscreen stage</dd>
					<dt class="archive-mono">?</dt><dd>Show this help</dd>
				</dl>
				<button type="button" class="mt-4 border border-[var(--archive-border)] px-3 py-2 text-[13px] hover:border-[var(--archive-gilt)]" onclick={() => (shortcutHelpOpen = false)}>Close</button>
			</div>
		</div>
	{/if}

	{#if findOpen}
		<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
			<form
				class="w-full max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 shadow-lg"
				onsubmit={(event) => {
					event.preventDefault();
					submitFind();
				}}
			>
				<label class="block text-[13px] font-medium text-[var(--archive-subtle)]">
					Search this work
					<input bind:value={findQuery} class="mt-2 w-full border border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 py-2 text-[15px] text-[var(--archive-text)]" />
				</label>
				<div class="mt-4 flex justify-end gap-2">
					<button type="button" class="border border-[var(--archive-border)] px-3 py-2 text-[13px]" onclick={() => (findOpen = false)}>Cancel</button>
					<button type="submit" class="border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)]">Search</button>
				</div>
			</form>
		</div>
	{/if}
{/if}

<style>
	.reader-text-panel {
		width: var(--reader-panel-width);
		max-width: 50vw;
		min-width: 280px;
		overflow: auto;
	}
	@media (max-width: 767px) {
		.reader-grid {
			display: block;
		}
		.reader-text-panel {
			position: fixed;
			inset: auto 0 0 0;
			z-index: 40;
			max-height: 55svh;
			width: auto;
			max-width: none;
			min-width: 0;
			border-left: 0;
			border-top: 1px solid var(--archive-border);
			box-shadow: 0 -12px 30px rgb(0 0 0 / 18%);
		}
	}
</style>
