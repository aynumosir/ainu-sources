import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import * as schema from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import {
	exportApprovedSnapshot,
	verifyApprovedSnapshots
} from '../../../../scripts/archive/approved-snapshot';
import { ArchiveHttpError } from './errors';
import { replaceOcrPages, searchOcr } from './ocr';
import type { ArchivePrincipal } from './types';
import {
	approvePageEdit,
	buildRevisionTextExport,
	getPageStatusMap,
	getWorkspaceRevisionText,
	listPageEditLog,
	revertPageToMachine,
	savePageEdit,
	unapprovePageEdit
} from './workspace';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

const contributor: ArchivePrincipal = {
	userId: 'contributor',
	role: 'archive_contributor',
	identity: { kind: 'github_login', value: 'contributor' },
	authn: 'access_jwt'
};
const reviewer: ArchivePrincipal = {
	userId: 'reviewer',
	role: 'archive_reviewer',
	identity: { kind: 'github_login', value: 'reviewer' },
	authn: 'access_jwt'
};
const reader: ArchivePrincipal = {
	userId: 'reader',
	role: 'archive_reader',
	identity: { kind: 'github_login', value: 'reader' },
	authn: 'access_jwt'
};

let db: Db;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: `file:/tmp/archive-workspace-${crypto.randomUUID()}.db` });
	const database = drizzle(client, { schema });
	await migrate(database, { migrationsFolder: MIGRATIONS });
	return database;
}

async function seedRevision(): Promise<void> {
	await db.insert(user).values([
		{ id: 'contributor', name: 'Contributor', email: 'contributor@example.test' },
		{ id: 'reviewer', name: 'Reviewer', email: 'reviewer@example.test' },
		{ id: 'reader', name: 'Reader', email: 'reader@example.test' }
	]);
	await db.insert(schema.sources).values({
		id: 'source-1',
		slug: 'source-one',
		title: 'Source One',
		category: 'primary',
		type: 'book',
		humanDownload: true
	});
	await db.insert(schema.archiveRepositories).values({ id: 'repo-1', name: 'books' });
	await db.insert(schema.sourceFiles).values({
		id: 'file-1',
		sourceId: 'source-1',
		role: 'scan',
		checkoutRepoId: 'repo-1',
		checkoutPath: 'books/source-one.pdf',
		createdBy: 'contributor'
	});
	await db.insert(schema.archiveBlobs).values({
		sha256: 'a'.repeat(64),
		bytes: 100,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 3,
		blobSha256: 'a'.repeat(64),
		originalFilename: 'source-one.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		pageCount: 3,
		reviewStatus: 'approved',
		isCurrent: true,
		submittedBy: 'contributor',
		reviewedBy: 'reviewer',
		reviewedAt: new Date()
	});
	await db.insert(schema.revisionOcrCoverage).values({
		revisionId: 'rev-1',
		variant: 'gemini',
		status: 'complete',
		preferred: true,
		tool: 'gemini'
	});
	await replaceOcrPages(db, 'rev-1', 'gemini', [
		{ page: 1, text: 'machine first' },
		{ page: 2, text: 'machine second' }
	]);
}

beforeEach(async () => {
	db = await makeDb();
	await seedRevision();
});

describe('whole-document text', () => {
	it('refuses page-level edits when the text has no page boundaries', async () => {
		// Replace the page-aligned machine text with a single page-0 block, the
		// shape produced by extraction that carries no page structure.
		await replaceOcrPages(db, 'rev-1', 'gemini', [{ page: 0, text: 'the entire book' }]);

		await expect(
			savePageEdit(db, 'rev-1', 1, contributor, {
				text: 'corrected page one',
				base: { kind: 'variant', variant: 'manual' }
			})
		).rejects.toMatchObject({ status: 422 });
	});

	it('still allows editing the whole-document block itself', async () => {
		await replaceOcrPages(db, 'rev-1', 'gemini', [{ page: 0, text: 'the entire book' }]);

		const saved = await savePageEdit(db, 'rev-1', 0, contributor, {
			text: 'the entire book, corrected',
			base: { kind: 'variant', variant: 'gemini' }
		});
		expect(saved.page).toBe(0);
	});
});

describe('OCR page workspace ledger', () => {
	it('rejects the second save from the same machine base with the current head and text', async () => {
		const first = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'first correction',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await expect(
			savePageEdit(db, 'rev-1', 1, contributor, {
				text: 'second correction',
				base: { kind: 'variant', variant: 'gemini' }
			})
		).rejects.toMatchObject({
			status: 409,
			details: {
				current: {
					edit_id: first.edit_id,
					edited_by: 'contributor',
					text: 'first correction'
				}
			}
		});
	});

	it('approves one exact head and treats repeat approval as idempotent', async () => {
		const saved = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'reviewed correction',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await expect(approvePageEdit(db, 'rev-1', 1, 'stale-edit', reviewer)).rejects.toBeInstanceOf(ArchiveHttpError);
		const approved = await approvePageEdit(db, 'rev-1', 1, saved.edit_id, reviewer, {
			now: new Date('2026-07-19T01:02:03.000Z')
		});
		expect(approved).toEqual({
			page: 1,
			edit_id: saved.edit_id,
			status: 'approved',
			approved_by: 'reviewer',
			approved_at: '2026-07-19T01:02:03.000Z'
		});
		await approvePageEdit(db, 'rev-1', 1, saved.edit_id, reviewer);
		const approvals = await db
			.select()
			.from(schema.ocrPageEditEvents)
			.where(eq(schema.ocrPageEditEvents.kind, 'approve'));
		expect(approvals).toHaveLength(1);
	});

	it('demotes an approved page when a new edit is saved', async () => {
		const first = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'approved text',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await approvePageEdit(db, 'rev-1', 1, first.edit_id, reviewer);
		const second = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'changed after review',
			base: { kind: 'edit', editId: first.edit_id }
		});
		const [state] = await db
			.select()
			.from(schema.ocrPageState)
			.where(and(eq(schema.ocrPageState.revisionId, 'rev-1'), eq(schema.ocrPageState.page, 1)));
		expect(state).toMatchObject({ currentEditId: second.edit_id, status: 'edited', approver: null, approvedAt: null });
		const log = await listPageEditLog(db, 'rev-1', 1);
		expect(log.entries.map((entry) => entry.kind)).toContain('demote');
	});

	it('unapproves and reverts while retaining immutable edit history', async () => {
		const saved = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'temporary searchable phrase',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await approvePageEdit(db, 'rev-1', 1, saved.edit_id, reviewer);
		await expect(unapprovePageEdit(db, 'rev-1', 1, reviewer)).resolves.toMatchObject({ status: 'edited' });
		await expect(revertPageToMachine(db, 'rev-1', 1, contributor)).resolves.toEqual({
			page: 1,
			status: 'machine',
			variant: 'gemini',
			manual: false
		});
		const edits = await db.select().from(schema.ocrPageEdits);
		expect(edits).toHaveLength(1);
		expect((await listPageEditLog(db, 'rev-1', 1)).entries.map((entry) => entry.kind)).toEqual([
			'revert',
			'unapprove',
			'approve',
			'edit'
		]);
		expect((await searchOcr(db, reader, { q: 'temporary' })).items).toHaveLength(0);
	});

	it('returns status and exact edit metadata for edited text', async () => {
		const saved = await savePageEdit(db, 'rev-1', 3, contributor, {
			text: 'manual transcription',
			base: { kind: 'variant', variant: 'manual' }
		});
		expect(saved.variant).toBe('manual');
		expect(await getPageStatusMap(db, 'rev-1')).toEqual({
			pages: [
				{ page: 1, status: 'machine', variant: 'gemini', manual: false },
				{ page: 2, status: 'machine', variant: 'gemini', manual: false },
				{ page: 3, status: 'edited', variant: 'manual', manual: true, edit_id: saved.edit_id }
			]
		});
		const text = await getWorkspaceRevisionText(db, 'rev-1', 3, { variant: 'manual' });
		expect(text).toMatchObject({
			variant: 'manual',
			pages: [
				{
					page: 3,
					text: 'manual transcription',
					status: 'edited',
					edit_id: saved.edit_id,
					edited_by: 'contributor',
					approved_by: null
				}
			]
		});
	});

	it('updates the current search table inside the save transaction', async () => {
		await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'newly indexed correction',
			base: { kind: 'variant', variant: 'gemini' }
		});
		const result = await searchOcr(db, reader, { q: 'newly' });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ revisionId: 'rev-1', page: 1, variant: 'edited' });
	});
});

describe('OCR text exports', () => {
	it('renders form-feed text and page-keyed JSONL records', async () => {
		const page1 = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'approved first',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await approvePageEdit(db, 'rev-1', 1, page1.edit_id, reviewer);
		await savePageEdit(db, 'rev-1', 2, contributor, {
			text: 'unapproved second',
			base: { kind: 'variant', variant: 'gemini' }
		});

		const workingText = await buildRevisionTextExport(db, 'rev-1', { format: 'txt', variant: 'working' });
		expect(workingText.filename).toBe('source-one.r3.working.txt');
		expect(workingText.body).toContain('⟦ p.1 · variant: edited · status: approved ⟧\napproved first');
		expect(workingText.body).toContain('\f');
		expect(workingText.body).toContain('⟦ p.2 · variant: edited · status: edited ⟧\nunapproved second');

		const approvedJsonl = await buildRevisionTextExport(db, 'rev-1', { format: 'jsonl', variant: 'approved' });
		const records = approvedJsonl.body
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(Object.keys(records[0])).toEqual([
			'chunk_id',
			'source_slug',
			'file_id',
			'revision_id',
			'page',
			'seq',
			'variant',
			'status',
			'text',
			'checksum'
		]);
		expect(records[0]).toMatchObject({ page: 1, variant: 'edited', status: 'approved', text: 'approved first' });
		expect(records[1]).toMatchObject({ page: 2, variant: 'gemini', status: 'machine', text: 'machine second' });
		expect(records.every((record) => typeof record.checksum === 'string' && record.checksum.length === 64)).toBe(true);
	});

	it('exports a pinned approved snapshot and rejects it after head demotion', async () => {
		const saved = await savePageEdit(db, 'rev-1', 1, contributor, {
			text: 'publication text',
			base: { kind: 'variant', variant: 'gemini' }
		});
		await approvePageEdit(db, 'rev-1', 1, saved.edit_id, reviewer);
		const root = await mkdtemp(join(tmpdir(), 'approved-snapshot-'));
		try {
			const exported = await exportApprovedSnapshot(db, 'rev-1', root, {
				now: new Date('2026-07-19T00:00:00.000Z'),
				resultingCommit: 'abc123'
			});
			expect(exported.manifest).toMatchObject({
				exporter_version: 'ocr-page-snapshot/1',
				revision_id: 'rev-1',
				resulting_commit: 'abc123',
				pages: [{ page: 1, edit_id: saved.edit_id }]
			});
			expect(await readFile(exported.textPath, 'utf8')).toBe('--- page 1 ---\npublication text\n');
			await expect(verifyApprovedSnapshots(db, root)).resolves.toEqual({ manifests: 1, pages: 1 });
			await savePageEdit(db, 'rev-1', 1, contributor, {
				text: 'new head',
				base: { kind: 'edit', editId: saved.edit_id }
			});
			await expect(verifyApprovedSnapshots(db, root)).rejects.toThrow('no longer current and approved');
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
