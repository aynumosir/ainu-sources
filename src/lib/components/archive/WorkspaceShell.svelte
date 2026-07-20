<script lang="ts">
	import { page as pageState } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { archiveFetch, archiveSession } from '$lib/archive/session.svelte';
	import { archiveRoleAtLeastClient, type ArchiveRoleName } from '$lib/archive/roles';
	import { WorkspaceState } from '$lib/archive/workspace.svelte';
	import {
		acceptSavedBuffer,
		chooseDefaultVariant,
		makeEditBuffer,
		resolveConflictChoice,
		restoreIntoBuffer,
		updateEditBuffer,
		type EditHead,
		type EditLogEntry,
		type OcrVariant,
		type PageStatus,
		type PageStatusRow,
		type PageText
	} from '$lib/archive/workspace';
	import { archiveLabels } from '$lib/archive/bilingual-labels';
	import BilingualLabel from './BilingualLabel.svelte';
	import PageScrubber from './PageScrubber.svelte';
	import ScanPane from './ScanPane.svelte';
	import TextColumn from './TextColumn.svelte';
	import TextExportDialog from './TextExportDialog.svelte';

	type LoadState = 'idle' | 'loading' | 'ready' | 'empty' | 'unavailable' | 'error';
	type TextResponse = {
		error?: string;
		note?: string;
		variant?: string;
		preferredVariant?: string;
		variants?: Array<string | { name?: string; variant?: string; label?: string; tool?: string; version?: string; kind?: string }>;
		pages?: Array<{
			page: number;
			text: string;
			variant?: string;
			status?: PageStatus;
			manual?: boolean;
			edit_id?: string | null;
			edited_by?: string | null;
			edited_at?: string | null;
			approved_by?: string | null;
			approved_at?: string | null;
		}>;
	};

	let { file, revision, source, initialPage, wholeDocument = false, role }: {
		file: { fileId: string; label?: string | null };
		revision: { id: string; revisionNo: number; pageCount: number };
		source: { slug: string; title: string };
		initialPage: number;
		wholeDocument?: boolean;
		role: ArchiveRoleName;
	} = $props();

	const workspace = new WorkspaceState(untrack(() => initialPage));
	const canEdit = $derived(archiveRoleAtLeastClient(role, 'archive_contributor'));
	const canApprove = $derived(archiveRoleAtLeastClient(role, 'archive_reviewer'));
	const pageCount = $derived(Math.max(1, revision.pageCount));
	const readerStorageKey = $derived(`archive-reader:${file.fileId}`);
	const flipStorageKey = $derived(`archive-workspace:pane-order:${archiveSession.principal?.userId ?? 'anonymous'}`);

	let mounted = $state(false);
	let pageField = $state(untrack(() => String(initialPage)));
	let statusRows = $state<PageStatusRow[]>([]);
	let statusUnavailable = $state(false);
	let statusError = $state<string | null>(null);
	let fileNoOcr = $state(false);
	let loadStates = $state<Record<number, LoadState>>({});
	let loadMessages = $state<Record<number, string>>({});
	let textRecords = $state<Record<string, PageText>>({});
	let pageVariants = $state<Record<number, OcrVariant[]>>({});
	let selectedVariants = $state<Record<number, string | null>>({});
	let notes = $state<Record<number, string>>({});
	let savingPages = $state<Record<number, boolean>>({});
	let saveErrors = $state<Record<number, string>>({});
	let conflicts = $state<Record<number, EditHead>>({});
	let conflictNotes = $state<Record<number, string>>({});
	let conflictErrors = $state<Record<number, string>>({});
	let historyEntries = $state<Record<number, EditLogEntry[]>>({});
	let historyLoading = $state<Record<number, boolean>>({});
	let historyUnavailable = $state<Record<number, boolean>>({});
	let historyErrors = $state<Record<number, string>>({});
	let operationBusy = $state(false);
	let operationMessage = $state<string | null>(null);
	let scrubberThumbnail = $state<string | null>(null);
	let overflowOpen = $state(false);
	let shortcutHelpOpen = $state(false);
	let copyMessage = $state<string | null>(null);
	let exportDialog: { open: () => void } | undefined = $state();

	const currentPage = $derived(workspace.currentPage);
	const currentSelected = $derived(selectedVariants[currentPage] ?? null);
	const currentRecord = $derived(currentSelected ? textRecords[textKey(currentPage, currentSelected)] ?? fallbackRecord(currentPage) : null);
	const currentBuffer = $derived(workspace.buffers[currentPage] ?? null);
	const currentLoadState = $derived(loadStates[currentPage] ?? 'idle');
	const currentVariants = $derived(pageVariants[currentPage] ?? []);
	const readerHref = $derived(`/archive/read/${source.slug}/${file.fileId}?p=${currentPage}`);

	onMount(() => {
		mounted = true;
		restorePreferences();
		void loadStatusMap();
		const keydown = (event: KeyboardEvent) => handleShortcut(event);
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (!workspace.hasDirtyBuffers()) return;
			event.preventDefault();
			event.returnValue = '';
		};
		window.addEventListener('keydown', keydown);
		window.addEventListener('beforeunload', beforeUnload);
		return () => {
			window.removeEventListener('keydown', keydown);
			window.removeEventListener('beforeunload', beforeUnload);
		};
	});

	$effect(() => {
		pageField = String(currentPage);
		if (!mounted) return;
		replacePageParam();
		persistPage();
		void loadPageText(currentPage);
	});

	function textKey(page: number, variant: string): string {
		return `${page}:${variant}`;
	}

	function statusFor(page: number): PageStatusRow | undefined {
		return statusRows.find((row) => row.page === page);
	}

	function fallbackRecord(page: number): PageText | null {
		const selected = selectedVariants[page];
		const row = statusFor(page);
		if (!selected || !row || !workspace.buffers[page]) return null;
		return {
			page,
			text: workspace.buffers[page].text,
			variant: selected,
			status: row.status,
			manual: row.manual,
			editId: row.edit_id ?? null,
			editedBy: null,
			editedAt: null,
			approvedBy: null,
			approvedAt: null
		};
	}

	function restorePreferences(): void {
		const queryPage = parsePage(pageState.url.searchParams.get('p'));
		try {
			const saved = JSON.parse(localStorage.getItem(readerStorageKey) ?? '{}') as { page?: number };
			workspace.currentPage = clampPage(queryPage ?? saved.page ?? initialPage);
		} catch {
			workspace.currentPage = clampPage(queryPage ?? initialPage);
		}
		const paneOrder = localStorage.getItem(flipStorageKey);
		workspace.paneOrder = paneOrder === 'text-first' ? 'text-first' : 'scan-first';
	}

	function persistPage(): void {
		try {
			const saved = JSON.parse(localStorage.getItem(readerStorageKey) ?? '{}') as Record<string, unknown>;
			localStorage.setItem(readerStorageKey, JSON.stringify({ ...saved, page: currentPage }));
		} catch {
			localStorage.setItem(readerStorageKey, JSON.stringify({ page: currentPage }));
		}
	}

	function replacePageParam(): void {
		const url = new URL(window.location.href);
		url.searchParams.set('p', String(currentPage));
		history.replaceState(history.state, '', url);
	}

	function flipPanes(): void {
		workspace.paneOrder = workspace.paneOrder === 'scan-first' ? 'text-first' : 'scan-first';
		localStorage.setItem(flipStorageKey, workspace.paneOrder);
	}

	function goToPage(page: number): void {
		workspace.currentPage = clampPage(page);
	}

	function submitPageField(): void {
		goToPage(Number(pageField) || currentPage);
	}

	function parsePage(value: string | null): number | null {
		if (!value || !/^[1-9][0-9]*$/u.test(value)) return null;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}

	function clampPage(page: number): number {
		if (wholeDocument) return 0;
		return Math.min(Math.max(1, page), pageCount);
	}

	async function loadStatusMap(): Promise<void> {
		statusError = null;
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/status`);
			if (response.status === 404) {
				statusUnavailable = true;
				return;
			}
			if (!response.ok) {
				statusError = `Page status failed (${response.status}).`;
				return;
			}
			const body = await response.json() as { pages?: PageStatusRow[] };
			statusRows = Array.isArray(body.pages) ? body.pages.filter(validStatusRow) : [];
			fileNoOcr = statusRows.length > 0 && statusRows.every((row) => row.status === 'none');
			if ((loadStates[currentPage] === 'ready' || loadStates[currentPage] === 'empty') && !workspace.buffers[currentPage]?.dirty) {
				void loadPageText(currentPage, true);
			}
		} catch (error) {
			statusError = error instanceof Error ? error.message : 'Page status failed.';
		}
	}

	function validStatusRow(row: PageStatusRow): boolean {
		return Number.isSafeInteger(row.page)
			&& row.page >= (wholeDocument ? 0 : 1)
			&& row.page <= pageCount
			&& ['machine', 'edited', 'approved', 'none'].includes(row.status);
	}

	async function loadPageText(page: number, force = false, requestedVariant?: string): Promise<void> {
		if (!force && workspace.buffers[page] && (!requestedVariant || requestedVariant === workspace.buffers[page].variant)) {
			loadStates = { ...loadStates, [page]: 'ready' };
			return;
		}
		const row = statusFor(page);
		const selected = requestedVariant ?? selectedVariants[page] ?? (row?.status !== 'none' ? row?.variant : null);
		if (!force && selected && textRecords[textKey(page, selected)]) {
			loadStates = { ...loadStates, [page]: 'ready' };
			return;
		}
		loadStates = { ...loadStates, [page]: 'loading' };
		const params = new URLSearchParams({ pages: String(page) });
		if (selected) params.set('variant', selected);
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text?${params}`);
			if (response.status === 404) {
				loadStates = { ...loadStates, [page]: 'unavailable' };
				loadMessages = { ...loadMessages, [page]: 'The page-text endpoint has not been deployed.' };
				return;
			}
			if (!response.ok) {
				loadStates = { ...loadStates, [page]: 'error' };
				loadMessages = { ...loadMessages, [page]: await responseMessage(response, `OCR text failed (${response.status}).`) };
				return;
			}
			const body = await response.json() as TextResponse;
			if (body.error === 'ocr_unavailable' || !body.pages?.some((item) => item.page === page)) {
				fileNoOcr ||= body.error === 'ocr_unavailable' && statusUnavailable;
				prepareEmptyPage(page);
				return;
			}
			const raw = body.pages.find((item) => item.page === page)!;
			const variant = raw.variant ?? body.variant ?? selected ?? 'machine';
			const pageStatus = raw.status ?? row?.status ?? (variant === 'edited' || variant === 'manual' ? 'edited' : 'machine');
			const record = makePageText(raw, variant, pageStatus, row);
			textRecords = { ...textRecords, [textKey(page, variant)]: record };
			if (canEdit && (variant === 'edited' || variant === 'manual')) {
				const base = record.editId
					? { kind: 'edit' as const, edit_id: record.editId }
					: { kind: 'variant' as const, variant };
				workspace.setBuffer(page, makeEditBuffer({ text: record.text, base, variant }));
			}
			const variants = variantsFromResponse(body, record, row);
			pageVariants = { ...pageVariants, [page]: variants };
			selectedVariants = {
				...selectedVariants,
				[page]: requestedVariant ?? (row?.status !== 'none' ? row?.variant : null) ?? chooseDefaultVariant(variants, body.preferredVariant ?? body.variant) ?? variant
			};
			loadStates = { ...loadStates, [page]: 'ready' };
		} catch (error) {
			loadStates = { ...loadStates, [page]: 'error' };
			loadMessages = { ...loadMessages, [page]: error instanceof Error ? error.message : 'OCR text failed.' };
		}
	}

	function makePageText(raw: NonNullable<TextResponse['pages']>[number], variant: string, status: PageStatus, row?: PageStatusRow): PageText {
		return {
			page: raw.page,
			text: raw.text,
			variant,
			status,
			manual: raw.manual ?? row?.manual ?? variant === 'manual',
			editId: raw.edit_id ?? row?.edit_id ?? null,
			editedBy: raw.edited_by ?? null,
			editedAt: raw.edited_at ?? null,
			approvedBy: raw.approved_by ?? null,
			approvedAt: raw.approved_at ?? null
		};
	}

	function variantsFromResponse(body: TextResponse, record: PageText, row?: PageStatusRow): OcrVariant[] {
		const variants: OcrVariant[] = [];
		for (const item of body.variants ?? []) {
			const name = typeof item === 'string' ? item : item.name ?? item.variant;
			if (!name || variants.some((variant) => variant.name === name)) continue;
			const kind = name === 'edited' || name === 'manual' ? name : 'machine';
			const label = typeof item === 'string'
				? item
				: item.label ?? [item.tool ?? name, item.version].filter(Boolean).join(' ');
			variants.push({ name, label, kind, status: name === record.variant ? record.status : kind === 'machine' ? 'machine' : 'edited', manual: name === 'manual' });
		}
		if (!variants.some((variant) => variant.name === record.variant)) {
			const kind = record.variant === 'edited' || record.variant === 'manual' ? record.variant : 'machine';
			variants.push({ name: record.variant, label: record.variant, kind, status: record.status, manual: record.manual });
		}
		if (row && row.variant !== record.variant && !variants.some((variant) => variant.name === row.variant)) {
			const kind = row.variant === 'edited' || row.variant === 'manual' ? row.variant : 'machine';
			variants.push({ name: row.variant, label: row.variant, kind, status: row.status, manual: row.manual });
		}
		return variants.sort((left, right) => variantRank(left) - variantRank(right) || left.label.localeCompare(right.label));
	}

	function variantRank(variant: OcrVariant): number {
		return variant.kind === 'machine' ? 0 : variant.kind === 'edited' ? 1 : 2;
	}

	function prepareEmptyPage(page: number): void {
		loadStates = { ...loadStates, [page]: 'empty' };
		if (!canEdit) {
			pageVariants = { ...pageVariants, [page]: [] };
			selectedVariants = { ...selectedVariants, [page]: null };
			return;
		}
		const buffer = makeEditBuffer({ text: '', base: { kind: 'variant', variant: 'manual' }, variant: 'manual' });
		workspace.setBuffer(page, buffer);
		pageVariants = { ...pageVariants, [page]: [{ name: 'manual', label: 'manual', kind: 'manual', status: 'none', manual: true }] };
		selectedVariants = { ...selectedVariants, [page]: 'manual' };
	}

	async function selectVariant(variant: string): Promise<void> {
		selectedVariants = { ...selectedVariants, [currentPage]: variant };
		if (workspace.buffers[currentPage] && (variant === 'edited' || variant === 'manual')) return;
		await loadPageText(currentPage, false, variant);
	}

	function startEditing(): void {
		if (!canEdit) return;
		const record = currentRecord;
		const variant = currentLoadState === 'empty' ? 'manual' : 'edited';
		const base = record?.editId
			? { kind: 'edit' as const, edit_id: record.editId }
			: { kind: 'variant' as const, variant: record?.variant ?? 'manual' };
		workspace.setBuffer(currentPage, makeEditBuffer({ text: record?.text ?? '', base, variant }));
		const virtual: OcrVariant = { name: variant, label: variant, kind: variant, status: record?.status ?? 'none', manual: variant === 'manual' };
		const variants = currentVariants.some((item) => item.name === variant) ? currentVariants : [...currentVariants, virtual];
		pageVariants = { ...pageVariants, [currentPage]: variants };
		selectedVariants = { ...selectedVariants, [currentPage]: variant };
		loadStates = { ...loadStates, [currentPage]: currentLoadState === 'empty' ? 'empty' : 'ready' };
	}

	function updateCurrentText(text: string): void {
		const buffer = workspace.buffers[currentPage];
		if (!buffer) return;
		workspace.setBuffer(currentPage, updateEditBuffer(buffer, text));
		delete saveErrors[currentPage];
		saveErrors = { ...saveErrors };
	}

	async function saveCurrent(noteOverride?: string): Promise<void> {
		const page = currentPage;
		const buffer = workspace.buffers[page];
		if (!buffer?.dirty || savingPages[page]) return;
		savingPages = { ...savingPages, [page]: true };
		delete saveErrors[page];
		saveErrors = { ...saveErrors };
		const note = (noteOverride ?? notes[page] ?? '').trim();
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/pages/${page}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ text: buffer.text, base: buffer.base, ...(note ? { note } : {}) })
			});
			if (response.status === 404) {
				saveErrors = { ...saveErrors, [page]: '保存機能はまだ利用できません / Saving is not yet available.' };
				return;
			}
			if (response.status === 409) {
				const body = await response.json() as { current?: EditHead };
				if (body.current) conflicts = { ...conflicts, [page]: body.current };
				else saveErrors = { ...saveErrors, [page]: 'The current edit changed. Reload this page before saving.' };
				return;
			}
			if (!response.ok) {
				saveErrors = { ...saveErrors, [page]: await responseMessage(response, `Save failed (${response.status}).`) };
				return;
			}
			const result = await response.json() as { edit_id: string; page: number; variant: 'edited' | 'manual'; status: PageStatus; created_at: string };
			const accepted = acceptSavedBuffer(buffer, result);
			workspace.setBuffer(page, accepted);
			const record: PageText = {
				page,
				text: accepted.text,
				variant: result.variant,
				status: result.status,
				manual: result.variant === 'manual',
				editId: result.edit_id,
				editedBy: archiveSession.principal?.identity.value ?? null,
				editedAt: result.created_at,
				approvedBy: null,
				approvedAt: null
			};
			textRecords = { ...textRecords, [textKey(page, result.variant)]: record };
			selectedVariants = { ...selectedVariants, [page]: result.variant };
			upsertStatus({ page, status: result.status, variant: result.variant, manual: result.variant === 'manual', edit_id: result.edit_id });
			upsertVariant(page, { name: result.variant, label: result.variant, kind: result.variant, status: result.status, manual: result.variant === 'manual' });
			notes = { ...notes, [page]: '' };
			clearConflict(page);
			if (historyEntries[page]) void loadHistory(page, true);
		} catch (error) {
			saveErrors = { ...saveErrors, [page]: error instanceof Error ? error.message : 'Save failed.' };
		} finally {
			savingPages = { ...savingPages, [page]: false };
		}
	}

	function upsertStatus(row: PageStatusRow): void {
		statusRows = [...statusRows.filter((item) => item.page !== row.page), row].sort((left, right) => left.page - right.page);
	}

	function upsertVariant(page: number, variant: OcrVariant): void {
		pageVariants = { ...pageVariants, [page]: [...(pageVariants[page] ?? []).filter((item) => item.name !== variant.name), variant] };
	}

	function clearConflict(page: number): void {
		delete conflicts[page];
		delete conflictNotes[page];
		delete conflictErrors[page];
		conflicts = { ...conflicts };
		conflictNotes = { ...conflictNotes };
		conflictErrors = { ...conflictErrors };
	}

	async function useMine(): Promise<void> {
		const page = currentPage;
		const buffer = workspace.buffers[page];
		const theirs = conflicts[page];
		if (!buffer || !theirs) return;
		try {
			const resolution = resolveConflictChoice(buffer, theirs, 'mine', conflictNotes[page]);
			workspace.setBuffer(page, resolution.buffer);
			conflictErrors = { ...conflictErrors, [page]: '' };
			await saveCurrent(resolution.note);
		} catch (error) {
			conflictErrors = { ...conflictErrors, [page]: error instanceof Error ? error.message : 'Overwrite note is required.' };
		}
	}

	function useTheirs(): void {
		const page = currentPage;
		const buffer = workspace.buffers[page];
		const theirs = conflicts[page];
		if (!buffer || !theirs) return;
		const resolution = resolveConflictChoice(buffer, theirs, 'theirs');
		workspace.setBuffer(page, resolution.buffer);
		const variant = buffer.variant;
		textRecords = {
			...textRecords,
			[textKey(page, variant)]: {
				page,
				text: theirs.text,
				variant,
				status: 'edited',
				manual: variant === 'manual',
				editId: theirs.edit_id,
				editedBy: theirs.edited_by,
				editedAt: theirs.edited_at,
				approvedBy: null,
				approvedAt: null
			}
		};
		upsertStatus({ page, status: 'edited', variant, manual: variant === 'manual', edit_id: theirs.edit_id });
		clearConflict(page);
	}

	async function approveCurrent(): Promise<void> {
		const page = currentPage;
		const record = currentRecord;
		if (!record?.editId || operationBusy) return;
		operationBusy = true;
		operationMessage = null;
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/pages/${page}/approve`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ edit_id: record.editId })
			});
			if (response.status === 404) {
				operationMessage = '承認機能はまだ利用できません / Approval is not yet available.';
				return;
			}
			if (response.status === 409) {
				operationMessage = '本文が更新されました。新しい本文を確認してください / The text changed; review the new head.';
				delete textRecords[textKey(page, record.variant)];
				textRecords = { ...textRecords };
				await loadPageText(page, true, record.variant);
				return;
			}
			if (!response.ok) {
				operationMessage = await responseMessage(response, `Approval failed (${response.status}).`);
				return;
			}
			setCurrentStatus('approved');
			if (historyEntries[page]) void loadHistory(page, true);
		} finally {
			operationBusy = false;
		}
	}

	async function unapproveCurrent(): Promise<void> {
		await simplePost('unapprove', 'Approval withdrawal is not yet available.', () => setCurrentStatus('edited'));
	}

	async function revertCurrent(): Promise<void> {
		const page = currentPage;
		await simplePost('revert', 'Revert is not yet available.', async (response) => {
			const row = await response.json() as PageStatusRow;
			upsertStatus(row);
			workspace.clearBuffer(page);
			for (const variant of ['edited', 'manual']) delete textRecords[textKey(page, variant)];
			textRecords = { ...textRecords };
			selectedVariants = { ...selectedVariants, [page]: row.variant };
			await loadPageText(page, true, row.variant);
		});
	}

	async function simplePost(action: 'unapprove' | 'revert', unavailable: string, success: (response: Response) => void | Promise<void>): Promise<void> {
		if (operationBusy) return;
		operationBusy = true;
		operationMessage = null;
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/pages/${currentPage}/${action}`, { method: 'POST' });
			if (response.status === 404) {
				operationMessage = unavailable;
				return;
			}
			if (!response.ok) {
				operationMessage = await responseMessage(response, `${action} failed (${response.status}).`);
				return;
			}
			await success(response);
			if (historyEntries[currentPage]) void loadHistory(currentPage, true);
		} finally {
			operationBusy = false;
		}
	}

	function setCurrentStatus(status: PageStatus): void {
		const record = currentRecord;
		if (!record) return;
		textRecords = { ...textRecords, [textKey(currentPage, record.variant)]: { ...record, status } };
		upsertStatus({ page: currentPage, status, variant: record.variant, manual: record.manual, ...(record.editId ? { edit_id: record.editId } : {}) });
		upsertVariant(currentPage, { name: record.variant, label: record.variant, kind: record.variant === 'manual' ? 'manual' : record.variant === 'edited' ? 'edited' : 'machine', status, manual: record.manual });
	}

	async function loadHistory(page: number, force = false): Promise<void> {
		if (!force && (historyEntries[page] || historyUnavailable[page] || historyLoading[page])) return;
		historyLoading = { ...historyLoading, [page]: true };
		delete historyErrors[page];
		historyErrors = { ...historyErrors };
		try {
			const response = await archiveFetch(`/api/archive/revisions/${revision.id}/text/pages/${page}/edits`);
			if (response.status === 404) {
				historyUnavailable = { ...historyUnavailable, [page]: true };
				return;
			}
			if (!response.ok) {
				historyErrors = { ...historyErrors, [page]: await responseMessage(response, `History failed (${response.status}).`) };
				return;
			}
			const body = await response.json() as { entries?: EditLogEntry[] };
			historyEntries = { ...historyEntries, [page]: Array.isArray(body.entries) ? body.entries : [] };
		} finally {
			historyLoading = { ...historyLoading, [page]: false };
		}
	}

	function restoreEntry(entry: EditLogEntry): void {
		if (entry.text == null) return;
		if (!workspace.buffers[currentPage]) startEditing();
		const buffer = workspace.buffers[currentPage];
		if (buffer) workspace.setBuffer(currentPage, restoreIntoBuffer(buffer, entry.text));
	}

	async function copyCitation(): Promise<void> {
		await navigator.clipboard.writeText(`${source.title}, scan p.${currentPage}\n${pageState.url.origin}${readerHref}`);
		copyMessage = 'コピーしました / Copied';
		setTimeout(() => (copyMessage = null), 1500);
	}

	async function downloadOriginal(): Promise<void> {
		const response = await archiveFetch(`/api/archive/revisions/${revision.id}/content?disposition=attachment`);
		if (!response.ok) {
			operationMessage = response.status === 404 ? 'Original file is not yet available.' : `Download failed (${response.status}).`;
			return;
		}
		const url = URL.createObjectURL(await response.blob());
		const anchor = document.createElement('a');
		anchor.href = url;
		anchor.download = file.label ?? `${source.slug}.pdf`;
		anchor.click();
		URL.revokeObjectURL(url);
	}

	function handleShortcut(event: KeyboardEvent): void {
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && event.key.toLocaleLowerCase() === 's') {
			event.preventDefault();
			void saveCurrent();
			return;
		}
		if (modifier && event.key === 'ArrowLeft') {
			event.preventDefault();
			goToPage(currentPage - 1);
			return;
		}
		if (modifier && event.key === 'ArrowRight') {
			event.preventDefault();
			goToPage(currentPage + 1);
			return;
		}
		if (isTypingTarget(event.target)) return;
		if (event.key === 'ArrowLeft' || event.key === 'k') {
			event.preventDefault();
			goToPage(currentPage - 1);
		} else if (event.key === 'ArrowRight' || event.key === 'j') {
			event.preventDefault();
			goToPage(currentPage + 1);
		} else if (event.key === 'g') {
			event.preventDefault();
			document.getElementById('workspace-page-field')?.focus();
		} else if (event.key === '?') {
			event.preventDefault();
			shortcutHelpOpen = true;
		}
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		const element = target instanceof HTMLElement ? target : null;
		return !!element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || element.isContentEditable);
	}

	async function responseMessage(response: Response, fallback: string): Promise<string> {
		try {
			const body = await response.json() as { message?: unknown };
			return typeof body.message === 'string' ? body.message : fallback;
		} catch {
			return fallback;
		}
	}
</script>

<div class="workspace-shell">
	<header class="workspace-header">
		<div class="top-line">
			<a href={readerHref} class="back-link">← <BilingualLabel ja={archiveLabels.reader.ja} en={archiveLabels.reader.en} /></a>
			<h1 class="archive-title" title={source.title}>{source.title}</h1>
			<a href={`https://db.aynu.org/sources/${source.slug}`} target="_blank" rel="noreferrer" class="catalogue-link">catalogue ↗</a>
			{#if wholeDocument}
				<p class="whole-document-note">全文 Whole document</p>
			{:else}
				<div class="page-nav">
					<button type="button" aria-label="Previous page" onclick={() => goToPage(currentPage - 1)}>‹</button>
					<form onsubmit={(event) => { event.preventDefault(); submitPageField(); }}>
						<input id="workspace-page-field" inputmode="numeric" bind:value={pageField} aria-label="Page" />
						<span>/ {pageCount}</span>
					</form>
					<button type="button" aria-label="Next page" onclick={() => goToPage(currentPage + 1)}>›</button>
				</div>
			{/if}
			<button type="button" class="flip" title="Swap panes" aria-label="Swap scan and text panes" onclick={flipPanes}>⇄</button>
			<div class="menu-wrap">
				<button type="button" class="menu-button" aria-label="Workspace menu" onclick={() => (overflowOpen = !overflowOpen)}>⋯</button>
				{#if overflowOpen}
					<div class="menu">
						<button type="button" onclick={() => { overflowOpen = false; exportDialog?.open(); }}><BilingualLabel ja={archiveLabels.exportText.ja} en={archiveLabels.exportText.en} /></button>
						<button type="button" onclick={() => { overflowOpen = false; void copyCitation(); }}><BilingualLabel ja={archiveLabels.copyCitation.ja} en={archiveLabels.copyCitation.en} /></button>
						<button type="button" onclick={() => { overflowOpen = false; void downloadOriginal(); }}><BilingualLabel ja={archiveLabels.download.ja} en={archiveLabels.download.en} /></button>
						<button type="button" onclick={() => { overflowOpen = false; shortcutHelpOpen = true; }}><BilingualLabel ja={archiveLabels.shortcuts.ja} en={archiveLabels.shortcuts.en} /></button>
					</div>
				{/if}
			</div>
		</div>
		<PageScrubber
			page={currentPage}
			{pageCount}
			statuses={statusRows}
			dirtyPages={workspace.dirtyPages()}
			thumbnailSrc={scrubberThumbnail}
			onpage={goToPage}
		/>
		<div class="mobile-tabs" aria-label="Workspace pane">
			<button type="button" class:active={workspace.mobilePane === 'scan'} onclick={() => (workspace.mobilePane = 'scan')}><BilingualLabel ja={archiveLabels.scan.ja} en={archiveLabels.scan.en} /></button>
			<button type="button" class:active={workspace.mobilePane === 'text'} onclick={() => (workspace.mobilePane = 'text')}><BilingualLabel ja={archiveLabels.text.ja} en={archiveLabels.text.en} /></button>
		</div>
	</header>

	{#if fileNoOcr}
		<p class="file-gap">この資料にはOCRテキストがありません — page images only; your transcription starts the text.</p>
	{/if}
	{#if statusUnavailable}
		<p class="rollout-note">ページ状態マップはまだ利用できません / Page status map is not yet available.</p>
	{:else if statusError}
		<p class="rollout-note error">{statusError}</p>
	{/if}
	{#if operationMessage}<p class="operation-note">{operationMessage}</p>{/if}
	{#if copyMessage}<p class="toast">{copyMessage}</p>{/if}

	<div class:text-first={workspace.paneOrder === 'text-first'} class="workspace-grid">
		<div class:mobile-hidden={workspace.mobilePane !== 'scan'} class="scan-cell">
			<ScanPane
				revisionId={revision.id}
				page={wholeDocument ? 1 : currentPage}
				{pageCount}
				onpage={goToPage}
				onthumbnail={(src) => (scrubberThumbnail = src)}
			/>
		</div>
		<div class:mobile-hidden={workspace.mobilePane !== 'text'} class="text-cell">
			<TextColumn
				page={currentPage}
				loadState={currentLoadState}
				loadMessage={loadMessages[currentPage] ?? null}
				record={currentRecord}
				variants={currentVariants}
				selected={currentSelected}
				buffer={currentBuffer}
				{canEdit}
				{canApprove}
				saving={savingPages[currentPage] ?? false}
				saveError={saveErrors[currentPage] ?? null}
				note={notes[currentPage] ?? ''}
				conflict={conflicts[currentPage] ?? null}
				conflictNote={conflictNotes[currentPage] ?? ''}
				conflictError={conflictErrors[currentPage] ?? null}
				historyEntries={historyEntries[currentPage] ?? []}
				historyLoading={historyLoading[currentPage] ?? false}
				historyUnavailable={historyUnavailable[currentPage] ?? false}
				historyError={historyErrors[currentPage] ?? null}
				{operationBusy}
				onselect={(variant) => void selectVariant(variant)}
				onstartedit={startEditing}
				ontext={updateCurrentText}
				onnote={(note) => (notes = { ...notes, [currentPage]: note })}
				onsave={() => void saveCurrent()}
				onapprove={() => void approveCurrent()}
				onhistoryopen={() => void loadHistory(currentPage)}
				onrestore={restoreEntry}
				onrevert={() => void revertCurrent()}
				onunapprove={() => void unapproveCurrent()}
				onconflictnote={(note) => (conflictNotes = { ...conflictNotes, [currentPage]: note })}
				onusemine={() => void useMine()}
				onusetheirs={useTheirs}
			/>
		</div>
	</div>
</div>

<TextExportDialog bind:this={exportDialog} {revision} slug={source.slug} />

{#if shortcutHelpOpen}
	<div class="help-backdrop">
		<div class="help-sheet" role="dialog" aria-modal="true" aria-label="Workspace shortcuts">
			<header><BilingualLabel tag="h2" ja={archiveLabels.shortcuts.ja} en={archiveLabels.shortcuts.en} /><button type="button" onclick={() => (shortcutHelpOpen = false)}>×</button></header>
			<dl>
				<dt>← → / k j</dt><dd>Previous or next page</dd>
				<dt>Ctrl/Cmd + ← →</dt><dd>Turn page from any control</dd>
				<dt>Ctrl/Cmd + S</dt><dd>Save the current buffer</dd>
				<dt>g</dt><dd>Focus page field</dd>
				<dt>?</dt><dd>Open shortcut help</dd>
			</dl>
		</div>
	</div>
{/if}

<style>
	.workspace-shell { display: flex; height: 100svh; min-height: 0; flex-direction: column; overflow: hidden; background: var(--archive-bg); color: var(--archive-text); }
	.workspace-header { position: relative; z-index: 30; flex: none; border-bottom: 1px solid var(--archive-border); background: var(--archive-paper); }
	.top-line { display: flex; min-width: 0; align-items: center; gap: 0.6rem; border-bottom: 1px dotted var(--archive-border); padding: 0.5rem 0.75rem; }
	.back-link,
	.catalogue-link { flex: none; color: var(--archive-gilt-text); font-size: 12px; }
	h1 { min-width: 5rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 17px; font-weight: 650; }
	.whole-document-note {
		margin: 0;
		font-size: 12px;
		color: var(--archive-subtle);
		white-space: nowrap;
	}

	.page-nav { display: flex; flex: none; align-items: center; border: 1px solid var(--archive-border); }
	.page-nav button { width: 1.8rem; height: 1.9rem; color: var(--archive-subtle); }
	.page-nav form { display: flex; align-items: center; border-inline: 1px solid var(--archive-border); padding-right: 0.35rem; font-size: 12px; color: var(--archive-subtle); }
	.page-nav input { width: 3.4rem; height: 1.9rem; border: 0; background: var(--archive-panel); padding: 0 0.35rem; text-align: right; color: var(--archive-text); font-variant-numeric: tabular-nums; }
	.flip,
	.menu-button { width: 2rem; height: 2rem; border: 1px solid var(--archive-border); color: var(--archive-subtle); }
	.menu-wrap { position: relative; }
	.menu { position: absolute; top: calc(100% + 0.4rem); right: 0; z-index: 50; display: grid; width: 15rem; border: 1px solid var(--archive-border); background: var(--archive-paper); padding: 0.5rem; box-shadow: 0 10px 30px rgb(0 0 0 / 22%); }
	.menu button { padding: 0.45rem; text-align: left; color: var(--archive-gilt-text); font-size: 12px; }
	.mobile-tabs { display: none; }
	.file-gap,
	.rollout-note,
	.operation-note { flex: none; border-bottom: 1px solid var(--archive-border); background: var(--archive-panel); padding: 0.35rem 0.75rem; font-size: 12px; color: var(--archive-subtle); }
	.rollout-note { position: absolute; right: 0.75rem; bottom: 0.15rem; z-index: 32; border: 0; background: color-mix(in srgb, var(--archive-paper) 88%, transparent); padding: 0.1rem 0.3rem; font-size: 10px; }
	.error,
	.operation-note { color: var(--archive-danger); }
	.toast { position: fixed; top: 4.5rem; right: 1rem; z-index: 60; border: 1px solid var(--archive-border); background: var(--archive-paper); padding: 0.5rem 0.7rem; font-size: 12px; box-shadow: 0 4px 18px rgb(0 0 0 / 20%); }
	.workspace-grid { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(320px, 42%) minmax(0, 1fr); }
	.scan-cell,
	.text-cell { display: flex; min-width: 0; min-height: 0; }
	.scan-cell { grid-column: 1; grid-row: 1; border-right: 1px solid var(--archive-border); }
	.text-cell { grid-column: 2; grid-row: 1; }
	.scan-cell > :global(*),
	.text-cell > :global(*) { flex: 1; }
	.workspace-grid.text-first { grid-template-columns: minmax(0, 1fr) minmax(320px, 42%); }
	.text-first .text-cell { grid-column: 1; border-right: 1px solid var(--archive-border); }
	.text-first .scan-cell { grid-column: 2; border-right: 0; }
	.help-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; background: rgb(0 0 0 / 45%); padding: 1rem; }
	.help-sheet { width: min(32rem, 100%); border: 1px solid var(--archive-border); background: var(--archive-paper); }
	.help-backdrop header { display: flex; justify-content: space-between; border-bottom: 1px dotted var(--archive-border); padding: 0.8rem 1rem; }
	.help-backdrop dl { display: grid; grid-template-columns: 8rem 1fr; gap: 0.55rem; padding: 1rem; font-size: 12px; }
	.help-backdrop dt { font-family: var(--font-archive-mono); }
	@media (max-width: 899px) {
		.workspace-shell { height: 100svh; }
		.top-line { flex-wrap: wrap; }
		h1 { order: -1; width: calc(100% - 5rem); flex-basis: calc(100% - 5rem); }
		.catalogue-link { display: none; }
		.flip { display: none; }
		.page-nav { margin-left: auto; }
		.mobile-tabs { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px dotted var(--archive-border); }
		.mobile-tabs button { padding: 0.45rem; color: var(--archive-subtle); font-size: 12px; }
		.mobile-tabs button + button { border-left: 1px solid var(--archive-border); }
		.mobile-tabs button.active { background: var(--archive-gilt); color: var(--archive-paper); }
		.workspace-grid,
		.workspace-grid.text-first { grid-template-columns: minmax(0, 1fr); }
		.scan-cell,
		.text-cell,
		.text-first .scan-cell,
		.text-first .text-cell { grid-column: 1; grid-row: 1; border: 0; }
		.mobile-hidden { visibility: hidden; pointer-events: none; }
		.rollout-note { display: none; }
	}
</style>
