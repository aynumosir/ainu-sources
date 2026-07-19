<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import ArchiveHead from './ArchiveHead.svelte';
	import BilingualLabel from './BilingualLabel.svelte';
	import PendingSubmissions from './PendingSubmissions.svelte';
	import RevisionHistory from './RevisionHistory.svelte';
	import { archiveFetch } from '$lib/archive/session.svelte';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import { formatBytes, middleEllipsis } from '$lib/archive/format';
	import { centuryLabel, centuryOf, formatYear } from '$lib/format';

	type Sheet = 'pages' | 'about' | 'find' | null;
	type ImageEntry =
		| { status: 'loading'; src: null }
		| { status: 'ready'; src: string }
		| { status: 'missing'; src: null };

	let { work }: { work: any } = $props();

	const source = $derived(work.detail.source);
	const pageCount = $derived(work.revision.pageCount);
	const author = $derived(
		source.author?.trim() ||
		work.detail.persons
			.filter((person: any) => person.role === 'author')
			.map((person: any) => person.name)
			.join(', ') ||
		'not recorded'
	);
	const year = $derived(formatYear(source) === '—' ? 'not recorded' : formatYear(source));
	const era = $derived(
		centuryOf(source.yearStart) == null ? 'not recorded' : centuryLabel(centuryOf(source.yearStart)!, 'en')
	);
	const publishers = $derived(
		work.detail.institutions
			.filter((institution: any) => institution.role === 'publisher')
			.map((institution: any) => institution.name)
			.join(', ') || 'not recorded'
	);
	let currentPage = $state(untrack(() => work.initialPage));
	let pageField = $state(untrack(() => String(work.initialPage)));
	let images = $state<Record<number, ImageEntry>>({});
	let imageNotice = $state<string | null>(null);
	let copyStatus = $state<string | null>(null);
	let sheet = $state<Sheet>(null);
	let findQuery = $state('');
	let thumbList: HTMLElement | undefined = $state();
	let thumbScrollTop = $state(0);
	let thumbViewport = $state(640);
	const citation = $derived(`${author}. ${source.title}. ${year}. aynumosir archive: page ${currentPage}.`);

	const objectUrls = new Set<string>();
	const THUMB_ROW_HEIGHT = 116;
	const virtualStart = $derived(Math.max(0, Math.floor(thumbScrollTop / THUMB_ROW_HEIGHT) - 3));
	const virtualEnd = $derived(
		Math.min(pageCount, Math.ceil((thumbScrollTop + thumbViewport) / THUMB_ROW_HEIGHT) + 3)
	);
	const visiblePages = $derived(
		Array.from({ length: Math.max(0, virtualEnd - virtualStart) }, (_, index) => virtualStart + index + 1)
	);
	const selectedImage = $derived(images[currentPage]);

	onMount(() => {
		if (thumbList) thumbViewport = thumbList.clientHeight;
		const keydown = (event: KeyboardEvent) => {
			if (isTypingTarget(event.target)) return;
			if (event.key === 'ArrowLeft') {
				event.preventDefault();
				go(-1);
			}
			if (event.key === 'ArrowRight') {
				event.preventDefault();
				go(1);
			}
		};
		window.addEventListener('keydown', keydown);
		return () => {
			window.removeEventListener('keydown', keydown);
			for (const url of objectUrls) URL.revokeObjectURL(url);
		};
	});

	$effect(() => {
		const center = currentPage;
		void loadImageWindow(center);
	});

	function clampPage(value: number): number {
		return Math.min(Math.max(1, value), pageCount);
	}

	function go(delta: number): void {
		setPage(currentPage + delta);
	}

	function setPage(value: number): void {
		const next = clampPage(value);
		if (next === currentPage) return;
		currentPage = next;
		pageField = String(next);
		const nextUrl = `/archive/work/${encodeURIComponent(source.slug)}/p/${next}`;
		history.replaceState(history.state, '', nextUrl);
		requestAnimationFrame(() => revealCurrentThumbnail());
	}

	function jumpToField(): void {
		setPage(Number(pageField) || currentPage);
		pageField = String(currentPage);
	}

	function revealCurrentThumbnail(): void {
		if (!thumbList) return;
		const top = (currentPage - 1) * THUMB_ROW_HEIGHT;
		const bottom = top + THUMB_ROW_HEIGHT;
		if (top < thumbList.scrollTop) thumbList.scrollTo({ top, behavior: 'smooth' });
		if (bottom > thumbList.scrollTop + thumbList.clientHeight) {
			thumbList.scrollTo({ top: bottom - thumbList.clientHeight, behavior: 'smooth' });
		}
	}

	function updateThumbnailWindow(event: Event): void {
		const element = event.currentTarget as HTMLElement;
		thumbScrollTop = element.scrollTop;
		thumbViewport = element.clientHeight;
	}

	async function loadImageWindow(center: number): Promise<void> {
		const pages = Array.from({ length: 7 }, (_, index) => center + index - 3).filter(
			(page) => page >= 1 && page <= pageCount
		);
		await Promise.all(pages.map((page) => loadImage(page)));
	}

	async function loadImage(page: number): Promise<void> {
		if (images[page]) return;
		images = { ...images, [page]: { status: 'loading', src: null } };
		const response = await archiveFetch(
			`/api/archive/revisions/${work.revision.id}/pages/${page}.webp?w=1200`
		);
		if (response.status === 429) imageNotice = 'Archive usage limit reached. Try again after the usage window resets.';
		if (response.status === 410) imageNotice = 'This revision has been removed from the archive.';
		if (!response.ok) {
			images = { ...images, [page]: { status: 'missing', src: null } };
			return;
		}
		const src = URL.createObjectURL(await response.blob());
		objectUrls.add(src);
		images = { ...images, [page]: { status: 'ready', src } };
	}

	async function copyCitation(): Promise<void> {
		await navigator.clipboard.writeText(citation);
		copyStatus = 'Copied';
		setTimeout(() => {
			copyStatus = null;
		}, 1600);
	}

	function submitFind(): void {
		const query = findQuery.trim();
		if (!query) return;
		location.href = `/archive/search?q=${encodeURIComponent(query)}&source_slug=${encodeURIComponent(source.slug)}`;
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
	}

	function field(value: unknown): string {
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (Array.isArray(value) && value.length) return value.join(', ');
		return 'not recorded';
	}

	function filename(file: any): string {
		return file.label ?? file.checkoutPath?.split('/').at(-1) ?? `${source.slug}-${file.fileId}`;
	}
</script>

{#snippet contentsPanel()}
	<div class="flex h-full min-h-0 flex-col">
		<div class="border-b border-dotted border-[var(--archive-border)] p-3">
			<BilingualLabel tag="h2" ja="目次" en="Contents" class="text-[15px] font-semibold" />
			<form
				class="mt-3 flex items-center gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					jumpToField();
				}}
			>
				<label for="work-page-field" class="text-[12px] text-[var(--archive-subtle)]">Jump to page</label>
				<input
					id="work-page-field"
					inputmode="numeric"
					bind:value={pageField}
					class="tnum h-8 min-w-0 flex-1 border border-[var(--archive-border)] bg-[var(--archive-panel)] px-2 text-center text-[13px]"
				/>
			</form>
		</div>
		<div
			class="min-h-0 flex-1 overflow-y-auto"
			bind:this={thumbList}
			onscroll={updateThumbnailWindow}
			aria-label="Page thumbnails"
		>
			<div class="relative" style={`height:${pageCount * THUMB_ROW_HEIGHT}px`}>
				{#each visiblePages as page (page)}
					<button
						type="button"
						onclick={() => {
							setPage(page);
							sheet = null;
						}}
						aria-current={page === currentPage ? 'page' : undefined}
						class={`absolute left-0 flex h-[116px] w-full items-start gap-2 border-b border-dotted border-[var(--archive-border)] p-2 text-left ${
							page === currentPage
								? 'bg-[var(--archive-muted)] text-[var(--archive-text)]'
								: 'bg-[var(--archive-paper)] text-[var(--archive-subtle)] hover:bg-[var(--archive-panel)]'
						}`}
						style={`transform:translateY(${(page - 1) * THUMB_ROW_HEIGHT}px)`}
					>
						<span class="relative flex h-[96px] w-16 shrink-0 items-center justify-center overflow-hidden border border-[var(--archive-border)] bg-white">
							<img
								src={`/api/archive/revisions/${work.revision.id}/pages/${page}.webp?w=300`}
								alt=""
								loading="lazy"
								class="h-full w-full object-contain"
							/>
						</span>
						<span class="tnum pt-1 text-[12px]">p. {page}</span>
						{#if page === currentPage}<span class="mt-1 h-2 w-2 rounded-full bg-[var(--archive-gilt)]" aria-hidden="true"></span>{/if}
					</button>
				{/each}
			</div>
		</div>
	</div>
{/snippet}

{#snippet findPanel()}
	<form
		class="p-4"
		onsubmit={(event) => {
			event.preventDefault();
			submitFind();
		}}
	>
		<BilingualLabel tag="h2" ja="資料内検索" en="Find in this work" class="text-[17px] font-semibold" />
		<label class="mt-4 block text-[13px] text-[var(--archive-subtle)]">
			Search OCR text
			<input bind:value={findQuery} class="mt-2 w-full border border-[var(--archive-border)] bg-[var(--archive-panel)] px-3 py-2 text-[15px]" />
		</label>
		<button type="submit" class="mt-3 border border-[var(--archive-gilt)] bg-[var(--archive-gilt)] px-3 py-2 text-[13px] font-semibold text-[var(--archive-paper)]">
			<BilingualLabel ja={archiveLabels.search.ja} en={archiveLabels.search.en} inverse />
		</button>
	</form>
{/snippet}

{#snippet aboutPanel()}
	<div class="space-y-4 p-4">
		<BilingualLabel tag="h2" ja="資料について" en="About this work" class="text-[17px] font-semibold" />

		<section class="border-t border-dotted border-[var(--archive-border)] pt-4">
			<BilingualLabel tag="h3" ja={archiveLabels.citation.ja} en={archiveLabels.citation.en} class="text-[15px] font-semibold" />
			<p class="mt-3 font-[var(--font-archive-serif)] text-[15px] leading-7">
				{author}. <cite>{source.title}</cite>. {year}.<br />aynumosir archive: page <span class="tnum">{currentPage}</span>.
			</p>
			<button type="button" onclick={copyCitation} class="mt-3 border border-[var(--archive-border)] px-3 py-2 text-[13px] font-semibold hover:border-[var(--archive-gilt)]">
				<BilingualLabel ja={archiveLabels.copyCitation.ja} en={archiveLabels.copyCitation.en} />
			</button>
			{#if copyStatus}<span class="ml-2 text-[12px] text-[var(--archive-good)]" role="status">{copyStatus}</span>{/if}
		</section>

		<section class="border-t border-dotted border-[var(--archive-border)] pt-4">
			<BilingualLabel tag="h3" ja="書誌詳細" en="Bibliographic detail" class="text-[15px] font-semibold" />
			<dl class="mt-3 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[13px]">
				<dt class="text-[var(--archive-subtle)]">Dialect</dt><dd>{field(source.dialect)}</dd>
				<dt class="text-[var(--archive-subtle)]">Era</dt><dd>{era}</dd>
				<dt class="text-[var(--archive-subtle)]">Category</dt><dd>{field(source.category)}</dd>
				<dt class="text-[var(--archive-subtle)]">Type</dt><dd>{field(source.type)}</dd>
				<dt class="text-[var(--archive-subtle)]">Languages</dt><dd>{field(source.languages)}</dd>
				<dt class="text-[var(--archive-subtle)]">Publisher</dt><dd>{publishers}</dd>
				<dt class="text-[var(--archive-subtle)]">Institution</dt><dd>{field(source.holdingInstitution)}</dd>
				<dt class="text-[var(--archive-subtle)]">Call number</dt><dd class="archive-mono break-all text-[12px]">{field(source.callNumber)}</dd>
				<dt class="text-[var(--archive-subtle)]">Notes</dt><dd class="whitespace-pre-wrap">{field(source.notes)}</dd>
			</dl>
		</section>

		<details class="border-t border-dotted border-[var(--archive-border)] pt-4">
			<summary class="cursor-pointer text-[15px] font-semibold">
				<BilingualLabel ja={archiveLabels.files.ja} en={archiveLabels.files.en} />
				<span class="tnum ml-1 text-[12px] font-normal text-[var(--archive-subtle)]">{work.files.length}</span>
			</summary>
			<ul class="mt-3 space-y-3">
				{#each work.files as file (file.revisionId)}
					<li class="border-t border-dotted border-[var(--archive-border)] pt-3 first:border-0 first:pt-0">
						<p class="break-words text-[13px] font-medium">{filename(file)}</p>
						<p class="mt-1 text-[12px] text-[var(--archive-subtle)]">
							{file.role ?? 'file'} · {formatBytes(file.bytes)}{#if file.mediaType} · {file.mediaType}{/if}
						</p>
						{#if file.sha256}
							<details class="mt-1">
								<summary class="archive-mono cursor-pointer text-[11px] text-[var(--archive-subtle)]">{middleEllipsis(file.sha256)}</summary>
								<code class="archive-mono mt-1 block break-all text-[11px] text-[var(--archive-faint-text)]">{file.sha256}</code>
							</details>
						{/if}
						<a
							href={`/api/archive/revisions/${file.revisionId}/content?disposition=attachment`}
							target="_blank"
							rel="noreferrer"
							class="mt-2 inline-flex text-[12px] font-semibold text-[var(--archive-gilt-text)] underline decoration-dotted underline-offset-4"
						>
							Download
						</a>
					</li>
				{/each}
			</ul>
		</details>

		<details class="border-t border-dotted border-[var(--archive-border)] pt-4">
			<summary class="cursor-pointer text-[15px] font-semibold">
				<BilingualLabel ja="資料内検索" en="Find in this work" />
			</summary>
			<div class="-mx-4 -mb-4 mt-2">{@render findPanel()}</div>
		</details>

		<RevisionHistory revisions={work.revisions} />
		{#if work.pending.length}<PendingSubmissions items={work.pending} />{/if}
	</div>
{/snippet}

<ArchiveHead title={source.title} />

<article class="work-view flex min-h-0 flex-col bg-[var(--archive-bg)]">
	<header class="work-header sticky top-14 z-30 border-b border-[var(--archive-border-strong)] bg-[var(--archive-paper)] px-4 py-3">
		<div class="mx-auto flex max-w-[96rem] items-start gap-4">
			<a href="/archive" class="shrink-0 pt-1 text-[13px] font-medium text-[var(--archive-gilt-text)] hover:text-[var(--archive-gilt)]">← 資料一覧 Library</a>
			<div class="min-w-0 flex-1">
				<h1 class="archive-title truncate text-[19px] font-semibold">{source.title}</h1>
				<p class="mt-1 flex flex-wrap gap-x-2 text-[13px] text-[var(--archive-subtle)]">
					<span>{author}</span>
					<span>·</span><span class="tnum">{year}</span>
					<span>·</span><span>{work.file.role ?? 'file'}</span>
					<span>·</span><span class="tnum">page {currentPage} of {pageCount}</span>
					<span>·</span><span class="tnum">{formatBytes(work.revision.bytes)}</span>
				</p>
			</div>
		</div>
	</header>

	<div class="work-grid mx-auto grid min-h-0 w-full max-w-[96rem] flex-1">
		<aside class="work-contents min-h-0 border-r border-[var(--archive-border)] bg-[var(--archive-paper)]">
			{@render contentsPanel()}
		</aside>

		<section class="work-stage relative flex min-h-0 min-w-0 flex-col bg-[var(--archive-bg)]">
			<div class="relative flex min-h-[55svh] flex-1 items-center justify-center overflow-auto p-4">
				<button
					type="button"
					onclick={() => go(-1)}
					disabled={currentPage <= 1}
					aria-label="Previous page"
					class="absolute left-3 top-1/2 z-10 h-12 w-9 -translate-y-1/2 border border-[var(--archive-border)] bg-[var(--archive-paper)]/90 text-[21px] disabled:opacity-35"
				>‹</button>
				{#if imageNotice}
					<p class="max-w-md border border-[var(--archive-border)] bg-[var(--archive-paper)] p-5 text-center text-[13px] text-[var(--archive-subtle)]">{imageNotice}</p>
				{:else if selectedImage?.status === 'ready'}
					<img src={selectedImage.src} alt={`Page ${currentPage} of ${source.title}`} class="max-h-[calc(100svh-14rem)] max-w-full border border-[var(--archive-border)] bg-white object-contain shadow-sm" />
				{:else if selectedImage?.status === 'missing'}
					<p class="border border-dashed border-[var(--archive-border)] bg-[var(--archive-paper)] p-6 text-[13px] text-[var(--archive-subtle)]">Page image is unavailable.</p>
				{:else}
					<div class="h-[65svh] w-[min(70vw,40rem)] animate-pulse border border-[var(--archive-border)] bg-[var(--archive-paper)]" aria-label="Loading page image"></div>
				{/if}
				<button
					type="button"
					onclick={() => go(1)}
					disabled={currentPage >= pageCount}
					aria-label="Next page"
					class="absolute right-3 top-1/2 z-10 h-12 w-9 -translate-y-1/2 border border-[var(--archive-border)] bg-[var(--archive-paper)]/90 text-[21px] disabled:opacity-35"
				>›</button>
			</div>

			<div class="border-t border-[var(--archive-border)] bg-[var(--archive-paper)] px-3 py-2 text-center">
				<div class="inline-flex border border-[var(--archive-border)] text-[12px]">
					<button type="button" aria-pressed="true" class="bg-[var(--archive-gilt)] px-3 py-1.5 text-[var(--archive-paper)]">Image</button>
					<button type="button" disabled aria-describedby="text-view-reason" class="border-l border-[var(--archive-border)] px-3 py-1.5 text-[var(--archive-subtle)] opacity-55">Text</button>
					<button type="button" disabled aria-describedby="text-view-reason" class="side-by-side-option border-l border-[var(--archive-border)] px-3 py-1.5 text-[var(--archive-subtle)] opacity-55">Side-by-side</button>
				</div>
				<p id="text-view-reason" class="mt-1 text-[11px] text-[var(--archive-faint-text)]">OCR text is unavailable in this view.</p>
			</div>
		</section>

		<aside class="work-about min-h-0 overflow-y-auto border-l border-[var(--archive-border)] bg-[var(--archive-paper)]">
			{@render aboutPanel()}
		</aside>
	</div>

	<nav class="work-mobile-bar sticky bottom-0 z-30 grid grid-cols-3 border-t border-[var(--archive-border-strong)] bg-[var(--archive-paper)] text-[13px]" aria-label="Work tools">
		<button type="button" onclick={() => (sheet = 'pages')} class="px-3 py-3">頁 Pages</button>
		<button type="button" onclick={() => (sheet = 'about')} class="border-x border-[var(--archive-border)] px-3 py-3">資料 About</button>
		<button type="button" onclick={() => (sheet = 'find')} class="px-3 py-3">検索 Find</button>
	</nav>

	{#if sheet}
		<div class="work-sheet fixed inset-0 z-50 flex items-end bg-black/35" role="presentation">
			<button type="button" aria-label="Close sheet" class="absolute inset-0 h-full w-full" onclick={() => (sheet = null)}></button>
			<section class="relative max-h-[78svh] w-full overflow-y-auto border-t border-[var(--archive-border-strong)] bg-[var(--archive-paper)] shadow-xl">
				<div class="sticky top-0 z-10 flex justify-end border-b border-dotted border-[var(--archive-border)] bg-[var(--archive-paper)] px-4 py-2">
					<button type="button" class="text-[13px] text-[var(--archive-gilt-text)]" onclick={() => (sheet = null)}>Close</button>
				</div>
				{#if sheet === 'pages'}
					<div class="h-[65svh]">{@render contentsPanel()}</div>
				{:else if sheet === 'about'}
					{@render aboutPanel()}
				{:else}
					{@render findPanel()}
				{/if}
			</section>
		</div>
	{/if}
</article>

<style>
	.work-view {
		height: calc(100svh - 3.5rem);
	}
	.work-grid {
		grid-template-columns: 10rem minmax(0, 1fr) 21rem;
	}
	.work-mobile-bar,
	.work-sheet {
		display: none;
	}
	@media (max-width: 1099px) {
		.work-view {
			height: auto;
			min-height: calc(100svh - 3.5rem);
		}
		.work-grid {
			display: block;
		}
		.work-contents,
		.work-about {
			display: none;
		}
		.work-stage {
			min-height: calc(100svh - 10rem);
		}
		.work-mobile-bar {
			display: grid;
		}
		.work-sheet {
			display: flex;
		}
		.side-by-side-option {
			display: none;
		}
	}
	@media (max-width: 640px) {
		.work-header {
			top: 3.5rem;
		}
		.work-header > div {
			gap: 0.6rem;
		}
	}
</style>
