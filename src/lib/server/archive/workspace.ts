import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import {
	fileRevisions,
	ocrPageEditEvents,
	ocrPageEdits,
	ocrPageState,
	revisionOcrCoverage,
	sourceFiles,
	sources
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { base64url, fromBase64url } from './crypto';
import { decodePageCursor, encodePageCursor } from './cursor';
import { ArchiveHttpError } from './errors';
import { parsePageSelector } from './ocr';
import { iso, type ArchivePrincipal } from './types';

type Db = LibSQLDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

type MachinePage = { variant: string; page: number; text: string };
type EditHead = {
	editId: string;
	variant: 'edited' | 'manual';
	text: string;
	author: string;
	createdAt: Date;
};

export type PageEditBase =
	| { kind: 'edit'; editId: string }
	| { kind: 'variant'; variant: string };

export type PageStatusRow = {
	page: number;
	status: 'machine' | 'edited' | 'approved' | 'none';
	variant: string | null;
	manual: boolean;
	edit_id?: string;
};

export type RevisionTextExport = {
	body: string;
	contentType: string;
	filename: string;
	recordCount: number;
};

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_EDIT_LOG_LIMIT = 50;

function uuid(): string {
	return crypto.randomUUID();
}

function validatePage(page: number): void {
	if (!Number.isSafeInteger(page) || page < 0) throw new ArchiveHttpError(400, 'invalid page');
}

function validateNote(note: string | null | undefined): string | null {
	if (note == null || note === '') return null;
	const value = note.trim();
	if (!value) return null;
	if (/[\r\n]/u.test(value) || value.length > 500) throw new ArchiveHttpError(400, 'note must be one line and at most 500 characters');
	return value;
}

async function machinePages(db: Conn, revisionId: string): Promise<MachinePage[]> {
	return db.all<MachinePage>(sql`
		select variant, cast(page as integer) as page, text
		from ocr_pages
		where revision_id = ${revisionId} and variant <> 'edited'
		order by cast(page as integer), variant
	`);
}

async function preferredMachineVariant(db: Conn, revisionId: string): Promise<string | null> {
	const [row] = await db
		.select({ variant: revisionOcrCoverage.variant })
		.from(revisionOcrCoverage)
		.where(and(eq(revisionOcrCoverage.revisionId, revisionId), eq(revisionOcrCoverage.preferred, true)))
		.limit(1);
	return row?.variant ?? null;
}

function machinePageByPreference(rows: MachinePage[], preferred: string | null): Map<number, MachinePage> {
	const byPage = new Map<number, MachinePage>();
	for (const row of rows) {
		const current = byPage.get(row.page);
		if (!current || (row.variant === preferred && current.variant !== preferred)) byPage.set(row.page, row);
	}
	return byPage;
}

async function currentHeads(db: Conn, revisionId: string) {
	return db
		.select({
			page: ocrPageState.page,
			status: ocrPageState.status,
			approver: ocrPageState.approver,
			approvedAt: ocrPageState.approvedAt,
			editId: ocrPageEdits.editId,
			variant: ocrPageEdits.variant,
			text: ocrPageEdits.text,
			author: ocrPageEdits.author,
			createdAt: ocrPageEdits.createdAt
		})
		.from(ocrPageState)
		.innerJoin(ocrPageEdits, eq(ocrPageState.currentEditId, ocrPageEdits.editId))
		.where(eq(ocrPageState.revisionId, revisionId));
}

async function currentHead(db: Conn, revisionId: string, page: number): Promise<EditHead | null> {
	const [row] = await db
		.select({
			editId: ocrPageEdits.editId,
			variant: ocrPageEdits.variant,
			text: ocrPageEdits.text,
			author: ocrPageEdits.author,
			createdAt: ocrPageEdits.createdAt
		})
		.from(ocrPageState)
		.innerJoin(ocrPageEdits, eq(ocrPageState.currentEditId, ocrPageEdits.editId))
		.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)))
		.limit(1);
	return (row as EditHead | undefined) ?? null;
}

function conflictWith(head: EditHead | null): ArchiveHttpError {
	return new ArchiveHttpError(409, 'page text changed', {
		current: head
			? {
					edit_id: head.editId,
					edited_by: head.author,
					edited_at: iso(head.createdAt),
					text: head.text
				}
			: null
	});
}

async function replaceEditedSearchPage(db: Conn, revisionId: string, page: number, text: string | null): Promise<void> {
	// TODO(ocr-chunks): Replace this ocr_pages write with the ocr_chunks generation-aware page replacement from migration 0013.
	await db.run(sql`
		delete from ocr_pages
		where revision_id = ${revisionId} and variant = 'edited' and cast(page as integer) = ${page}
	`);
	if (text != null) {
		await db.run(sql`
			insert into ocr_pages (revision_id, variant, page, text)
			values (${revisionId}, 'edited', ${page}, ${text})
		`);
	}
}

async function ensureBase(tx: Tx, revisionId: string, page: number, base: PageEditBase): Promise<void> {
	const head = await currentHead(tx, revisionId, page);
	if (base.kind === 'edit') {
		if (head?.editId !== base.editId) throw conflictWith(head);
		return;
	}
	if (head) throw conflictWith(head);
	const rows = await machinePages(tx, revisionId);
	const pageVariants = rows.filter((row) => row.page === page);
	if (base.variant === 'manual' && pageVariants.length === 0) return;
	if (!pageVariants.some((row) => row.variant === base.variant)) {
		throw new ArchiveHttpError(400, 'base variant is unavailable for this page');
	}
}

export async function savePageEdit(
	db: Db,
	revisionId: string,
	page: number,
	principal: ArchivePrincipal,
	input: { text: string; base: PageEditBase; note?: string | null },
	opts: { now?: Date } = {}
) {
	validatePage(page);
	const note = validateNote(input.note);
	const now = opts.now ?? new Date();
	return db.transaction(async (tx) => {
		await ensureBase(tx, revisionId, page, input.base);
		const [priorState] = await tx
			.select({ status: ocrPageState.status, currentEditId: ocrPageState.currentEditId })
			.from(ocrPageState)
			.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)))
			.limit(1);
		const hasMachine = (await machinePages(tx, revisionId)).some((row) => row.page === page);
		const variant = hasMachine ? ('edited' as const) : ('manual' as const);
		const editId = uuid();
		await tx.insert(ocrPageEdits).values({
			editId,
			revisionId,
			page,
			variant,
			text: input.text,
			baseEditId: input.base.kind === 'edit' ? input.base.editId : null,
			baseVariant: input.base.kind === 'variant' ? input.base.variant : null,
			note,
			author: principal.userId,
			createdAt: now
		});
		await tx
			.insert(ocrPageState)
			.values({ revisionId, page, currentEditId: editId, status: 'edited', approver: null, approvedAt: null })
			.onConflictDoUpdate({
				target: [ocrPageState.revisionId, ocrPageState.page],
				set: { currentEditId: editId, status: 'edited', approver: null, approvedAt: null }
			});
		await tx.insert(ocrPageEditEvents).values({
			revisionId,
			page,
			kind: 'edit',
			editId,
			actor: principal.userId,
			note,
			baseEditId: input.base.kind === 'edit' ? input.base.editId : null,
			createdAt: now
		});
		if (priorState?.status === 'approved') {
			await tx.insert(ocrPageEditEvents).values({
				revisionId,
				page,
				kind: 'demote',
				editId,
				actor: principal.userId,
				baseEditId: priorState.currentEditId,
				createdAt: now
			});
		}
		await replaceEditedSearchPage(tx, revisionId, page, input.text);
		return {
			edit_id: editId,
			page,
			variant,
			status: 'edited' as const,
			created_at: now.toISOString()
		};
	});
}

export async function approvePageEdit(
	db: Db,
	revisionId: string,
	page: number,
	editId: string,
	principal: ArchivePrincipal,
	opts: { now?: Date } = {}
) {
	validatePage(page);
	const now = opts.now ?? new Date();
	return db.transaction(async (tx) => {
		const [state] = await tx
			.select()
			.from(ocrPageState)
			.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)))
			.limit(1);
		const head = await currentHead(tx, revisionId, page);
		if (!state || state.currentEditId !== editId || !head) throw conflictWith(head);
		if (state.status !== 'approved') {
			await tx
				.update(ocrPageState)
				.set({ status: 'approved', approver: principal.userId, approvedAt: now })
				.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)));
			await tx.insert(ocrPageEditEvents).values({
				revisionId,
				page,
				kind: 'approve',
				editId,
				actor: principal.userId,
				createdAt: now
			});
		}
		return {
			page,
			edit_id: editId,
			status: 'approved' as const,
			approved_by: state.status === 'approved' ? state.approver : principal.userId,
			approved_at: iso(state.status === 'approved' ? state.approvedAt : now)
		};
	});
}

export async function unapprovePageEdit(
	db: Db,
	revisionId: string,
	page: number,
	principal: ArchivePrincipal,
	opts: { now?: Date } = {}
) {
	validatePage(page);
	const now = opts.now ?? new Date();
	return db.transaction(async (tx) => {
		const [state] = await tx
			.select()
			.from(ocrPageState)
			.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)))
			.limit(1);
		if (!state?.currentEditId) throw new ArchiveHttpError(409, 'page has no current edit');
		if (state.status === 'approved') {
			await tx
				.update(ocrPageState)
				.set({ status: 'edited', approver: null, approvedAt: null })
				.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)));
			await tx.insert(ocrPageEditEvents).values({
				revisionId,
				page,
				kind: 'unapprove',
				editId: state.currentEditId,
				actor: principal.userId,
				createdAt: now
			});
		}
		return { page, edit_id: state.currentEditId, status: 'edited' as const };
	});
}

export async function revertPageToMachine(
	db: Db,
	revisionId: string,
	page: number,
	principal: ArchivePrincipal,
	opts: { now?: Date } = {}
): Promise<PageStatusRow> {
	validatePage(page);
	const now = opts.now ?? new Date();
	await db.transaction(async (tx) => {
		const [state] = await tx
			.select()
			.from(ocrPageState)
			.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)))
			.limit(1);
		if (state?.currentEditId) {
			await tx
				.update(ocrPageState)
				.set({ currentEditId: null, status: 'machine', approver: null, approvedAt: null })
				.where(and(eq(ocrPageState.revisionId, revisionId), eq(ocrPageState.page, page)));
			await tx.insert(ocrPageEditEvents).values({
				revisionId,
				page,
				kind: 'revert',
				editId: state.currentEditId,
				actor: principal.userId,
				createdAt: now
			});
			await replaceEditedSearchPage(tx, revisionId, page, null);
		}
	});
	const result = await getPageStatusMap(db, revisionId);
	return result.pages.find((row) => row.page === page) ?? {
		page,
		status: 'none',
		variant: null,
		manual: false
	};
}

export async function getPageStatusMap(db: Conn, revisionId: string): Promise<{ pages: PageStatusRow[] }> {
	const [revision] = await db
		.select({ pageCount: fileRevisions.pageCount })
		.from(fileRevisions)
		.where(eq(fileRevisions.id, revisionId))
		.limit(1);
	if (!revision) throw new ArchiveHttpError(404, 'revision not found');
	const preferred = await preferredMachineVariant(db, revisionId);
	const machines = machinePageByPreference(await machinePages(db, revisionId), preferred);
	const heads = await currentHeads(db, revisionId);
	const headByPage = new Map(heads.map((row) => [row.page, row]));
	const pageNumbers = new Set<number>();
	for (let page = 1; page <= (revision.pageCount ?? 0); page += 1) pageNumbers.add(page);
	for (const page of machines.keys()) pageNumbers.add(page);
	for (const page of headByPage.keys()) pageNumbers.add(page);
	return {
		pages: [...pageNumbers]
			.sort((a, b) => a - b)
			.map((page) => {
				const head = headByPage.get(page);
				if (head) {
					return {
						page,
						status: head.status as 'edited' | 'approved',
						variant: head.variant,
						manual: head.variant === 'manual',
						edit_id: head.editId
					};
				}
				const machine = machines.get(page);
				return machine
					? { page, status: 'machine' as const, variant: machine.variant, manual: false }
					: { page, status: 'none' as const, variant: null, manual: false };
			})
	};
}

export async function getWorkspaceRevisionText(
	db: Db,
	revisionId: string,
	pageCount: number | null,
	opts: { variant?: string | null; pages?: string | null; cursor?: string | null; limit?: number } = {}
) {
	const selectedPages = parsePageSelector(opts.pages ?? null);
	const cursor = decodePageCursor(opts.cursor ?? null);
	if (opts.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const requestedVariant = opts.variant?.trim() || (await preferredMachineVariant(db, revisionId));
	if (!requestedVariant) return ocrUnavailable(revisionId, pageCount);
	const limit = opts.limit ?? DEFAULT_PAGE_LIMIT;
	const cursorPage = cursor?.page ?? -1;
	if (requestedVariant === 'edited' || requestedVariant === 'manual') {
		const clauses = [
			eq(ocrPageState.revisionId, revisionId),
			eq(ocrPageEdits.variant, requestedVariant),
			...(selectedPages?.length ? [inArray(ocrPageState.page, selectedPages)] : [])
		];
		const rows = await db
			.select({
				page: ocrPageState.page,
				text: ocrPageEdits.text,
				status: ocrPageState.status,
				editId: ocrPageEdits.editId,
				author: ocrPageEdits.author,
				createdAt: ocrPageEdits.createdAt,
				approver: ocrPageState.approver,
				approvedAt: ocrPageState.approvedAt
			})
			.from(ocrPageState)
			.innerJoin(ocrPageEdits, eq(ocrPageState.currentEditId, ocrPageEdits.editId))
			.where(and(...clauses, sql`${ocrPageState.page} > ${cursorPage}`))
			.orderBy(ocrPageState.page)
			.limit(limit + 1);
		if (rows.length === 0) return ocrUnavailable(revisionId, pageCount);
		const page = rows.slice(0, limit);
		const last = page.at(-1);
		return {
			revisionId,
			variant: requestedVariant,
			pages: page.map((row) => ({
				page: row.page,
				text: row.text,
				status: row.status,
				edit_id: row.editId,
				edited_by: row.author,
				edited_at: iso(row.createdAt),
				approved_by: row.approver,
				approved_at: iso(row.approvedAt)
			})),
			nextCursor: rows.length > limit && last ? encodePageCursor({ page: last.page }) : null
		};
	}
	const pageClause = selectedPages?.length
		? sql`and cast(page as integer) in (${sql.join(selectedPages.map((page) => sql`${page}`), sql`, `)})`
		: sql``;
	const rows = await db.all<{ page: number; text: string }>(sql`
		select cast(page as integer) as page, text
		from ocr_pages
		where revision_id = ${revisionId}
			and variant = ${requestedVariant}
			and cast(page as integer) > ${cursorPage}
			${pageClause}
		order by cast(page as integer)
		limit ${limit + 1}
	`);
	if (rows.length === 0) return ocrUnavailable(revisionId, pageCount);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		revisionId,
		variant: requestedVariant,
		pages: page.map((row) => ({
			page: row.page,
			text: row.text,
			status: 'machine' as const,
			edit_id: null,
			edited_by: null,
			edited_at: null,
			approved_by: null,
			approved_at: null
		})),
		nextCursor: rows.length > limit && last ? encodePageCursor({ page: last.page }) : null
	};
}

function encodeEditCursor(id: number): string {
	return base64url(new TextEncoder().encode(JSON.stringify({ id })));
}

function decodeEditCursor(value: string | null | undefined): number | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as { id?: unknown };
		return typeof parsed.id === 'number' && Number.isSafeInteger(parsed.id) && parsed.id > 0 ? parsed.id : null;
	} catch {
		return null;
	}
}

export async function listPageEditLog(
	db: Db,
	revisionId: string,
	page: number,
	opts: { cursor?: string | null; limit?: number } = {}
) {
	validatePage(page);
	const cursor = decodeEditCursor(opts.cursor);
	if (opts.cursor && cursor == null) throw new ArchiveHttpError(400, 'invalid cursor');
	const limit = opts.limit ?? DEFAULT_EDIT_LOG_LIMIT;
	const rows = await db
		.select({
			id: ocrPageEditEvents.id,
			kind: ocrPageEditEvents.kind,
			editId: ocrPageEditEvents.editId,
			actor: ocrPageEditEvents.actor,
			createdAt: ocrPageEditEvents.createdAt,
			note: ocrPageEditEvents.note,
			baseEditId: ocrPageEditEvents.baseEditId,
			restoredFrom: ocrPageEditEvents.restoredFrom,
			text: ocrPageEdits.text
		})
		.from(ocrPageEditEvents)
		.leftJoin(ocrPageEdits, eq(ocrPageEditEvents.editId, ocrPageEdits.editId))
		.where(
			and(
				eq(ocrPageEditEvents.revisionId, revisionId),
				eq(ocrPageEditEvents.page, page),
				...(cursor ? [lt(ocrPageEditEvents.id, cursor)] : [])
			)
		)
		.orderBy(desc(ocrPageEditEvents.id))
		.limit(limit + 1);
	const entries = rows.slice(0, limit);
	const last = entries.at(-1);
	return {
		entries: entries.map((row) => ({
			kind: row.kind,
			edit_id: row.editId,
			actor: row.actor,
			created_at: iso(row.createdAt),
			note: row.note,
			base_edit_id: row.baseEditId,
			restored_from: row.restoredFrom,
			text: row.kind === 'edit' ? row.text : undefined
		})),
		next_cursor: rows.length > limit && last ? encodeEditCursor(last.id) : null
	};
}

async function sha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildRevisionTextExport(
	db: Db,
	revisionId: string,
	input: { format: 'txt' | 'jsonl'; variant: 'working' | 'machine' | 'approved' }
): Promise<RevisionTextExport> {
	const [revision] = await db
		.select({
			revisionId: fileRevisions.id,
			revisionNo: fileRevisions.revisionNo,
			pageCount: fileRevisions.pageCount,
			fileId: sourceFiles.id,
			sourceSlug: sources.slug
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.where(eq(fileRevisions.id, revisionId))
		.limit(1);
	if (!revision) throw new ArchiveHttpError(404, 'revision not found');
	const preferred = await preferredMachineVariant(db, revisionId);
	const machines = machinePageByPreference(await machinePages(db, revisionId), preferred);
	const heads = new Map((await currentHeads(db, revisionId)).map((row) => [row.page, row]));
	const pages = new Set<number>();
	for (let page = 1; page <= (revision.pageCount ?? 0); page += 1) pages.add(page);
	for (const page of machines.keys()) pages.add(page);
	for (const page of heads.keys()) pages.add(page);
	const selected = [...pages].sort((a, b) => a - b).map((page) => {
		const machine = machines.get(page);
		const head = heads.get(page);
		if (input.variant === 'machine' || !head || (input.variant === 'approved' && head.status !== 'approved')) {
			return {
				page,
				variant: machine?.variant ?? 'none',
				status: machine ? ('machine' as const) : ('none' as const),
				text: machine?.text ?? ''
			};
		}
		return {
			page,
			variant: head.variant,
			status: head.status as 'edited' | 'approved',
			text: head.text
		};
	});
	const extension = input.format;
	const filename = `${revision.sourceSlug}.r${revision.revisionNo}.${input.variant}.${extension}`;
	if (input.format === 'txt') {
		const body =
			selected
				.map((row) => `⟦ p.${row.page} · variant: ${row.variant} · status: ${row.status} ⟧\n${row.text}`)
				.join('\n\f\n') + (selected.length ? '\n' : '');
		return { body, contentType: 'text/plain; charset=utf-8', filename, recordCount: selected.length };
	}
	const records = await Promise.all(
		selected.filter((row) => row.status !== 'none').map(async (row) => ({
			chunk_id: `${revisionId}:${row.page}:0${row.variant !== preferred ? `:${row.variant}` : ''}`,
			source_slug: revision.sourceSlug,
			file_id: revision.fileId,
			revision_id: revisionId,
			page: row.page,
			seq: 0,
			variant: row.variant,
			status: row.status,
			text: row.text,
			checksum: await sha256(row.text)
		}))
	);
	const body = records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
	return { body, contentType: 'application/x-ndjson; charset=utf-8', filename, recordCount: records.length };
}

function ocrUnavailable(revisionId: string, pageCount: number | null) {
	if (Number.isSafeInteger(pageCount) && pageCount != null && pageCount > 0) {
		return {
			error: 'ocr_unavailable',
			alternatives: Array.from({ length: pageCount }, (_, index) => {
				const page = index + 1;
				return { page, path: `/api/archive/revisions/${revisionId}/pages/${page}.webp` };
			})
		};
	}
	return { error: 'ocr_unavailable', alternatives: [], note: 'page count unavailable' };
}
