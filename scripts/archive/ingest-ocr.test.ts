/**
 * ingestOcr — the full ingest flow on an isolated libSQL in-memory database
 * built from the real drizzle migrations and a temporary OCR tree on disk.
 * Covers the quality verdict written per variant and the preferred flag the
 * tier rule leaves behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { ingestOcr } from './ingest-ocr';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

const CLEAN_LINE = '本書の第2刷に当たって，ぜひ付記しなければならないことは，我が国のアイヌ語研究の';
const BROKEN_LINE = [...'アイヌ語カラフトライシカ'].join(' ');

function ocrDocument(line: string, pages: number): string {
	const pageBody = Array.from({ length: 6 }, () => line).join('\n');
	return Array.from({ length: pages }, (_, index) => `--- page ${index + 1} ---\n${pageBody}`).join('\n');
}

let db: Db;
let tmpDir: string;
let ainuRoot: string;

beforeEach(async () => {
	// A file database rather than :memory: — the libsql driver opens a fresh
	// connection for transactions, which would see an empty in-memory database.
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-ocr-'));
	const client = createClient({ url: `file:${path.join(tmpDir, 'test.db')}` });
	db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	ainuRoot = path.join(tmpDir, 'root');
	await fs.mkdir(path.join(ainuRoot, 'ainu-grammar/books/ocr'), { recursive: true });
	await db.insert(schema.user).values({
		id: 'user-test',
		name: 'Test user',
		email: 'test@example.com',
		emailVerified: true
	});
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedRevision(stem: string): Promise<string> {
	const [source] = await db
		.insert(schema.sources)
		.values({ slug: stem, title: `Title of ${stem}`, type: 'dictionary' })
		.returning({ id: schema.sources.id });
	const [repo] = await db
		.insert(schema.archiveRepositories)
		.values({ name: `repo-${stem}` })
		.returning({ id: schema.archiveRepositories.id });
	const [file] = await db
		.insert(schema.sourceFiles)
		.values({
			sourceId: source.id,
			role: 'scan',
			checkoutRepoId: repo.id,
			checkoutPath: `books/x/${stem}.pdf`
		})
		.returning({ id: schema.sourceFiles.id });
	const blobSha256 = createHash('sha256').update(stem).digest('hex');
	await db.insert(schema.archiveBlobs).values({
		sha256: blobSha256,
		bytes: 1000,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	const [revision] = await db
		.insert(schema.fileRevisions)
		.values({
			sourceFileId: file.id,
			revisionNo: 1,
			blobSha256,
			originalFilename: `${stem}.pdf`,
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'user-test'
		})
		.returning({ id: schema.fileRevisions.id });
	return revision.id;
}

async function writeVariant(stem: string, variant: string, document: string): Promise<void> {
	await fs.writeFile(path.join(ainuRoot, `ainu-grammar/books/ocr/${stem}.${variant}.txt`), document);
}

async function coverageFor(revisionId: string) {
	return db
		.select({
			variant: schema.revisionOcrCoverage.variant,
			status: schema.revisionOcrCoverage.status,
			reliability: schema.revisionOcrCoverage.reliability,
			preferred: schema.revisionOcrCoverage.preferred
		})
		.from(schema.revisionOcrCoverage)
		.where(eq(schema.revisionOcrCoverage.revisionId, revisionId))
		.orderBy(sql`rowid`);
}

describe('ingestOcr', () => {
	it('records a single clean variant as complete, unassessed, preferred', async () => {
		const revisionId = await seedRevision('cleanbook');
		await writeVariant('cleanbook', 'pdftotext', ocrDocument(CLEAN_LINE, 3));

		await ingestOcr(db, { ainuRoot, dryRun: false });

		const rows = await coverageFor(revisionId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			variant: 'pdftotext',
			status: 'complete',
			reliability: 'unassessed',
			preferred: true
		});
	});

	it('marks a space-separated katakana layer suspect and keeps the clean variant preferred', async () => {
		const revisionId = await seedRevision('mixedbook');
		await writeVariant('mixedbook', 'pdftotext', ocrDocument(CLEAN_LINE, 3));
		await ingestOcr(db, { ainuRoot, dryRun: false });
		await writeVariant('mixedbook', 'gemini', ocrDocument(BROKEN_LINE, 3));

		await ingestOcr(db, { ainuRoot, dryRun: false });

		const rows = await coverageFor(revisionId);
		expect(rows).toHaveLength(2);
		const pdftotext = rows.find((row) => row.variant === 'pdftotext');
		const gemini = rows.find((row) => row.variant === 'gemini');
		expect(gemini).toMatchObject({ reliability: 'suspect', preferred: false });
		expect(pdftotext).toMatchObject({ reliability: 'unassessed', preferred: true });
	});

	it('moves the preferred flag when a clean variant arrives after a broken one', async () => {
		const revisionId = await seedRevision('flipbook');
		await writeVariant('flipbook', 'pdftotext', ocrDocument(BROKEN_LINE, 3));
		await ingestOcr(db, { ainuRoot, dryRun: false });
		const before = await coverageFor(revisionId);
		expect(before[0]).toMatchObject({ variant: 'pdftotext', reliability: 'suspect', preferred: true });

		await writeVariant('flipbook', 'gemini', ocrDocument(CLEAN_LINE, 3));
		await ingestOcr(db, { ainuRoot, dryRun: false });

		const rows = await coverageFor(revisionId);
		expect(rows.find((row) => row.variant === 'pdftotext')).toMatchObject({
			reliability: 'suspect',
			preferred: false
		});
		expect(rows.find((row) => row.variant === 'gemini')).toMatchObject({
			reliability: 'unassessed',
			preferred: true
		});
	});

	it('does not downgrade a human-certified variant and promotes it', async () => {
		const revisionId = await seedRevision('soundbook');
		await writeVariant('soundbook', 'pdftotext', ocrDocument(BROKEN_LINE, 3));
		await writeVariant('soundbook', 'gemini', ocrDocument(CLEAN_LINE, 3));
		await ingestOcr(db, { ainuRoot, dryRun: false });
		// Certify the broken layer by hand, then re-ingest changed content for it.
		await db
			.update(schema.revisionOcrCoverage)
			.set({ reliability: 'sound' })
			.where(
				and(
					eq(schema.revisionOcrCoverage.revisionId, revisionId),
					eq(schema.revisionOcrCoverage.variant, 'pdftotext')
				)
			);
		await writeVariant('soundbook', 'pdftotext', ocrDocument(BROKEN_LINE, 4));

		await ingestOcr(db, { ainuRoot, dryRun: false });

		const rows = await coverageFor(revisionId);
		expect(rows.find((row) => row.variant === 'pdftotext')).toMatchObject({
			reliability: 'sound',
			preferred: true
		});
		expect(rows.find((row) => row.variant === 'gemini')).toMatchObject({
			reliability: 'unassessed',
			preferred: false
		});
	});
});
