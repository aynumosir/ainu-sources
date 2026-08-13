/**
 * The merge runs once against real data, so what it does has to be visible
 * before it runs: which side survives, what happens to text only the other side
 * has, and whether the search index still matches the rows underneath.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { mergeDuplicateFiles } from './merge-duplicate-files';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

let db: Db;

beforeEach(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-files-'));
	db = drizzle(createClient({ url: `file:${path.join(dir, 'test.db')}` }), { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	// The uniqueness the merge exists to make possible is not in force while the
	// duplicates it repairs are still there.
	await db.run(sql`drop index if exists source_files_source_role_label_idx`);
	await db.insert(schema.user).values({ id: 'u1', name: 'U', email: 'u@example.test', emailVerified: true });
	await db.insert(schema.sources).values({
		id: 'src',
		slug: 'work-one',
		title: 'Work One',
		type: 'dictionary',
		humanDownload: true
	});
	await db.insert(schema.archiveRepositories).values([
		{ id: 'repo-a', name: 'repo-a' },
		{ id: 'repo-b', name: 'repo-b' }
	]);
	await db.insert(schema.archiveBlobs).values({
		sha256: 'a'.repeat(64),
		bytes: 10,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	for (const [file, repo, path_] of [
		['rich', 'repo-a', 'a/source.pdf'],
		['thin', 'repo-b', 'books/source.pdf']
	] as const) {
		await db.insert(schema.sourceFiles).values({ id: file, sourceId: 'src', role: 'scan' });
		await db.insert(schema.fileCheckouts).values({ id: `co-${file}`, sourceFileId: file, repoId: repo, path: path_ });
		await db.insert(schema.fileRevisions).values({
			id: `rev-${file}`,
			sourceFileId: file,
			revisionNo: 1,
			blobSha256: 'a'.repeat(64),
			originalFilename: 'source.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			isCurrent: true,
			submittedBy: 'u1'
		});
		await db.insert(schema.ocrIngestState).values({
			revisionId: `rev-${file}`,
			variant: 'gemini',
			contentHash: 'b'.repeat(64),
			pageCount: 2,
			activeGeneration: `gen-${file}`
		});
		await db.insert(schema.revisionOcrCoverage).values({
			revisionId: `rev-${file}`,
			variant: 'gemini',
			status: 'complete'
		});
	}
	// The rich side recognized pages 2 and 3 in two blocks each; the thin side
	// recognized pages 1 and 2, so page 1 exists nowhere else.
	await insertChunks('rev-rich', 'gen-rich', [
		{ page: 2, block: 0, text: 'kamuy nispa' },
		{ page: 2, block: 1, text: 'second block' },
		{ page: 3, block: 0, text: 'third page' }
	]);
	await insertChunks('rev-thin', 'gen-thin', [
		{ page: 1, block: 0, text: 'only on the thin side' },
		{ page: 2, block: 0, text: 'kamuy nispa again' }
	]);
	await db.insert(schema.revisionPageFolios).values([
		{ revisionId: 'rev-rich', page: 2, label: 'ii', derivedFrom: 'gemini' },
		{ revisionId: 'rev-thin', page: 1, label: 'i', derivedFrom: 'gemini' }
	]);
});

async function insertChunks(
	revisionId: string,
	generation: string,
	rows: Array<{ page: number; block: number; text: string }>
) {
	// ocr_chunks is written in raw SQL everywhere: it carries the FTS triggers
	// and has no drizzle table of its own.
	for (const row of rows) {
		await db.run(sql`
			insert into ocr_chunks (
				chunk_id, revision_id, variant, page, block, text, text_norm,
				checksum, normalization_version, ingest_generation
			) values (
				${`${generation}:${row.page}:${row.block}`}, ${revisionId}, 'gemini', ${row.page}, ${row.block},
				${row.text}, ${row.text}, ${'c'.repeat(64)}, 1, ${generation}
			)
		`);
	}
}

/** The same scan, held a second time by the dataset extracted from that book. */
async function secondRecordClaimingTheSameScan() {
	await mergeDuplicateFiles(db, { apply: true });   // collapse the two-repository pair first
	await db.insert(schema.sources).values({
		id: 'dataset',
		slug: 'work-one-comparison',
		title: 'Work One, comparison table',
		type: 'comparative-wordlist',
		humanDownload: true
	});
	await db.insert(schema.sourceFiles).values({ id: 'dataset-scan', sourceId: 'dataset', role: 'scan' });
	await db.insert(schema.archiveRepositories).values({ id: 'repo-c', name: 'repo-c' });
	await db.insert(schema.fileCheckouts).values({
		id: 'co-dataset',
		sourceFileId: 'dataset-scan',
		repoId: 'repo-c',
		path: 'dataset/source.pdf'
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-dataset',
		sourceFileId: 'dataset-scan',
		revisionNo: 1,
		blobSha256: 'a'.repeat(64),
		originalFilename: 'source.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		isCurrent: true,
		submittedBy: 'u1'
	});
	await db.insert(schema.ocrIngestState).values({
		revisionId: 'rev-dataset',
		variant: 'gemini',
		contentHash: 'd'.repeat(64),
		pageCount: 1,
		activeGeneration: 'gen-dataset'
	});
	await insertChunks('rev-dataset', 'gen-dataset', [{ page: 1, block: 0, text: 'held twice' }]);
}

describe('mergeDuplicateFiles', () => {
	it('reports the plan and writes nothing without --apply', async () => {
		const summary = await mergeDuplicateFiles(db, { apply: false });
		expect(summary).toMatchObject({ groups: 1, merged: 1, skipped: 0, filesRemoved: 1, pagesCarriedOver: 1 });
		expect(await db.select().from(schema.sourceFiles)).toHaveLength(2);
	});

	it('keeps the richer text, carries over the page only the other side had, and moves its checkout', async () => {
		await mergeDuplicateFiles(db, { apply: true });

		const files = await db.select().from(schema.sourceFiles);
		expect(files.map((file) => file.id)).toEqual(['rich']);

		const checkouts = await db.select().from(schema.fileCheckouts).orderBy(schema.fileCheckouts.path);
		expect(checkouts.map((row) => [row.sourceFileId, row.path])).toEqual([
			['rich', 'a/source.pdf'],
			['rich', 'books/source.pdf']
		]);

		const pages = await db.all<{ page: number }>(sql`
			select distinct page from ocr_chunks where revision_id = 'rev-rich' order by page
		`);
		expect(pages.map((row) => Number(row.page))).toEqual([1, 2, 3]);
	});

	it('leaves the carried-over page searchable through the surviving generation', async () => {
		await mergeDuplicateFiles(db, { apply: true });

		const visible = await db.all<{ page: number }>(sql`
			select c.page as page from ocr_chunks c
			join ocr_ingest_state st
				on st.revision_id = c.revision_id and st.variant = c.variant
				and st.active_generation = c.ingest_generation
			where c.revision_id = 'rev-rich' and c.page = 1
		`);
		expect(visible).toHaveLength(1);
		const [state] = await db
			.select({ pageCount: schema.ocrIngestState.pageCount })
			.from(schema.ocrIngestState)
			.where(eq(schema.ocrIngestState.revisionId, 'rev-rich'));
		expect(state.pageCount).toBe(3);
	});

	it('leaves the full-text index consistent with the rows behind it', async () => {
		await mergeDuplicateFiles(db, { apply: true });
		await expect(db.run(sql`insert into ocr_chunks_fts(ocr_chunks_fts) values('integrity-check')`)).resolves.toBeDefined();
		const hits = await db.all<{ n: number }>(sql`
			select count(*) as n from ocr_chunks_fts where ocr_chunks_fts match 'kamuy'
		`);
		expect(Number(hits[0].n)).toBe(1);
	});

	it('leaves a scan two records both claim alone until one is named', async () => {
		await secondRecordClaimingTheSameScan();

		const summary = await mergeDuplicateFiles(db, { apply: true });

		expect(summary).toMatchObject({ groups: 0, filesRemoved: 0 });
		const files = await db.select().from(schema.sourceFiles);
		expect(files.map((file) => file.sourceId).sort()).toEqual(['dataset', 'src']);
	});

	it('gives the scan to the record named by --adopt and moves the richer text under it', async () => {
		await secondRecordClaimingTheSameScan();

		await mergeDuplicateFiles(db, { apply: true, adopt: ['work-one'] });

		const files = await db.select().from(schema.sourceFiles);
		expect(files).toHaveLength(1);
		expect(files[0]).toMatchObject({ id: 'rich', sourceId: 'src' });
		const checkouts = await db.select().from(schema.fileCheckouts).orderBy(schema.fileCheckouts.path);
		expect(checkouts.map((row) => row.path)).toEqual(['a/source.pdf', 'books/source.pdf', 'dataset/source.pdf']);
	});

	it('refuses a group where either side carries human page edits', async () => {
		await db.insert(schema.ocrPageEdits).values({
			editId: 'edit-1',
			revisionId: 'rev-thin',
			page: 1,
			variant: 'edited',
			baseVariant: 'gemini',
			text: 'corrected by hand',
			author: 'u1'
		});

		const summary = await mergeDuplicateFiles(db, { apply: true });
		expect(summary).toMatchObject({ groups: 1, merged: 0, skipped: 1, filesRemoved: 0 });
		expect(await db.select().from(schema.sourceFiles)).toHaveLength(2);
	});
});
