import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { checkInvariants } from './check-invariants';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));

let client: Client;
let db: LibSQLDatabase<typeof schema>;

beforeEach(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-invariants-'));
	client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
	db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	await db.insert(schema.user).values({ id: 'u1', name: 'U', email: 'u@example.test', emailVerified: true });
	await db.insert(schema.sources).values([
		{ id: 'src', slug: 'work-one', title: 'Work One', type: 'dictionary', humanDownload: true },
		{ id: 'other', slug: 'work-two', title: 'Work Two', type: 'dictionary', humanDownload: true }
	]);
	await db.insert(schema.archiveBlobs).values({
		sha256: 'a'.repeat(64),
		bytes: 10,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	await db.insert(schema.sourceFiles).values({ id: 'file-1', sourceId: 'src', role: 'scan' });
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 1,
		blobSha256: 'a'.repeat(64),
		originalFilename: 'source.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		isCurrent: true,
		submittedBy: 'u1'
	});
	await db.insert(schema.ocrIngestState).values({
		revisionId: 'rev-1',
		variant: 'gemini',
		contentHash: 'b'.repeat(64),
		pageCount: 1,
		activeGeneration: 'gen-1'
	});
	await addChunk('rev-1', 'gen-1', 1);
});

async function addChunk(revisionId: string, generation: string, page: number, variant = 'gemini') {
	await db.run(sql`
		insert into ocr_chunks (
			chunk_id, revision_id, variant, page, block, text, text_norm,
			checksum, normalization_version, ingest_generation
		) values (
			${`${generation}:${page}:0`}, ${revisionId}, ${variant}, ${page}, 0,
			'kamuy', 'kamuy', ${'c'.repeat(64)}, 1, ${generation}
		)
	`);
}

/** A second file of another work, holding the same scan. */
async function secondFileOnTheSameBlob() {
	await db.insert(schema.sourceFiles).values({ id: 'file-2', sourceId: 'other', role: 'scan' });
	await db.insert(schema.fileRevisions).values({
		id: 'rev-2',
		sourceFileId: 'file-2',
		revisionNo: 1,
		blobSha256: 'a'.repeat(64),
		originalFilename: 'source.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		isCurrent: true,
		submittedBy: 'u1'
	});
}

describe('checkInvariants', () => {
	it('passes on an archive in the state the repairs left', async () => {
		expect(await checkInvariants(client)).toEqual([]);
	});

	it('catches one scan held as the current revision of two files', async () => {
		await secondFileOnTheSameBlob();

		const [violation] = await checkInvariants(client);

		expect(violation.check).toBe('one blob, one file');
		expect(violation.sample[0]).toContain('work-one');
		expect(violation.sample[0]).toContain('work-two');
	});

	it('catches an ingest state whose generation holds nothing', async () => {
		await db.run(sql`update ocr_ingest_state set active_generation = 'gen-missing' where revision_id = 'rev-1'`);

		const checks = (await checkInvariants(client)).map((violation) => violation.check);

		expect(checks).toContain('recognized text is reachable');
		expect(checks).toContain('no text outside a live generation');
	});

	it('catches text left behind with no state of its own', async () => {
		await addChunk('rev-1', 'gen-1', 2, 'pdftotext');

		const checks = (await checkInvariants(client)).map((violation) => violation.check);

		expect(checks).toContain('every chunk has an ingest state');
	});

	it('catches an index that no longer matches its rows', async () => {
		// What a delete reaching the table without the trigger leaves behind.
		await db.run(sql`drop trigger ocr_chunks_ad`);
		await db.run(sql`delete from ocr_chunks where revision_id = 'rev-1'`);

		const checks = (await checkInvariants(client)).map((violation) => violation.check);

		expect(checks).toContain('search index matches its rows');
	});
});
