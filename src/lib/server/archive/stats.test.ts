import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { env } from '$env/dynamic/private';
import * as schema from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import { archiveAuthzInternals } from './authz';
import { getArchiveStats } from './stats';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
const MIB = 1024 * 1024;

type Db = LibSQLDatabase<typeof schema>;

let db: Db;

function hash(index: number): string {
	return index.toString(16).padStart(64, '0');
}

async function makeDb(): Promise<Db> {
	const client = createClient({ url: `file:/tmp/archive-stats-test-${crypto.randomUUID()}.db` });
	const database = drizzle(client, { schema });
	await migrate(database, { migrationsFolder: MIGRATIONS });
	return database;
}

beforeEach(async () => {
	for (const key of Object.keys(env)) delete env[key];
	archiveAuthzInternals.setAppSessionLookupForTest(async () => null);
	db = await makeDb();
	await db.insert(user).values([
		{ id: 'reader', name: 'Reader', email: 'reader@example.test' },
		{ id: 'contributor', name: 'Contributor', email: 'contributor@example.test' },
		{ id: 'reviewer', name: 'Reviewer', email: 'reviewer@example.test' }
	]);
});

async function seedCollection(): Promise<void> {
	await db.insert(schema.sources).values([
		{
			id: 'source-1',
			slug: 'source-1',
			title: 'Source 1',
			category: 'primary',
			type: 'book',
			yearStart: 1880,
			dialect: 'Saru'
		},
		{
			id: 'source-2',
			slug: 'source-2',
			title: 'Source 2',
			category: 'secondary',
			type: 'article',
			yearStart: 1905,
			dialect: null
		},
		{
			id: 'source-3',
			slug: 'source-3',
			title: 'Source 3',
			category: 'corpus',
			type: 'corpus-text',
			yearStart: null,
			dialect: ''
		}
	]);
	await db.insert(schema.sourceFiles).values([
		{ id: 'file-1', sourceId: 'source-1', role: 'scan', createdBy: 'contributor' },
		{ id: 'file-2', sourceId: 'source-2', role: 'scan', createdBy: 'contributor' },
		{ id: 'file-3', sourceId: 'source-3', role: 'scan', createdBy: 'contributor' }
	]);
	await db.insert(schema.archiveBlobs).values([
		{
			sha256: hash(1),
			bytes: 0,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date(500)
		},
		{
			sha256: hash(2),
			bytes: 2 * MIB,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date(500)
		},
		{
			sha256: hash(3),
			bytes: 20 * MIB,
			detectedMediaType: 'image/tiff',
			storageState: 'verified',
			verifiedAt: new Date(500)
		},
		{
			sha256: hash(4),
			bytes: 100,
			detectedMediaType: 'application/zip',
			storageState: 'verified',
			verifiedAt: new Date(500)
		},
		{
			sha256: hash(5),
			bytes: 200,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date(500)
		}
	]);
	await db.insert(schema.fileRevisions).values([
		{
			id: 'revision-1',
			sourceFileId: 'file-1',
			revisionNo: 2,
			blobSha256: hash(1),
			originalFilename: 'one.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			pageCount: 12,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(1_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(2_000)
		},
		{
			id: 'revision-1-old',
			sourceFileId: 'file-1',
			revisionNo: 1,
			blobSha256: hash(1),
			originalFilename: 'one-old.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			pageCount: 10,
			reviewStatus: 'approved',
			isCurrent: false,
			submittedBy: 'contributor',
			submittedAt: new Date(700),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(800)
		},
		{
			id: 'revision-2',
			sourceFileId: 'file-2',
			revisionNo: 1,
			blobSha256: hash(2),
			originalFilename: 'two.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			pageCount: null,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(2_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(3_000)
		},
		{
			id: 'revision-3',
			sourceFileId: 'file-3',
			revisionNo: 1,
			blobSha256: hash(3),
			originalFilename: 'three.tiff',
			declaredMediaType: 'image/tiff',
			artifactKind: 'original',
			pageCount: 3,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(3_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(4_000)
		},
		{
			id: 'revision-pages',
			sourceFileId: 'file-1',
			revisionNo: 3,
			blobSha256: hash(4),
			originalFilename: 'pages.zip',
			declaredMediaType: 'application/zip',
			artifactKind: 'page_images',
			pageCount: 12,
			reviewStatus: 'approved',
			isCurrent: false,
			submittedBy: 'contributor',
			submittedAt: new Date(3_500),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(4_500)
		},
		{
			id: 'revision-linearized',
			sourceFileId: 'file-1',
			revisionNo: 4,
			blobSha256: hash(5),
			originalFilename: 'linearized.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'linearized',
			pageCount: 12,
			reviewStatus: 'approved',
			isCurrent: false,
			submittedBy: 'contributor',
			submittedAt: new Date(4_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(5_000)
		}
	]);
	await db.insert(schema.revisionDerivations).values([
		{ derivedRevisionId: 'revision-pages', parentRevisionId: 'revision-1', relation: 'page_images' },
		{ derivedRevisionId: 'revision-linearized', parentRevisionId: 'revision-1', relation: 'linearized' }
	]);
	await db.insert(schema.revisionOcrCoverage).values([
		{ revisionId: 'revision-1', variant: 'normalized', status: 'complete', tool: null },
		{ revisionId: 'revision-1', variant: 'raw', status: 'complete', tool: 'tesseract' },
		{ revisionId: 'revision-2', variant: 'raw', status: 'partial', tool: 'tesseract' }
	]);
	await db.insert(schema.ocrIngestState).values([
		{
			revisionId: 'revision-1',
			variant: 'raw',
			contentHash: hash(11),
			pageCount: 1,
			activeGeneration: 'generation-raw-1',
			ingestedAt: new Date(6_000)
		},
		{
			revisionId: 'revision-1',
			variant: 'normalized',
			contentHash: hash(12),
			pageCount: 1,
			activeGeneration: 'generation-normalized-1',
			ingestedAt: new Date(7_000)
		},
		{
			revisionId: 'revision-2',
			variant: 'raw',
			contentHash: hash(13),
			pageCount: 1,
			activeGeneration: 'generation-raw-2',
			ingestedAt: new Date(8_000)
		}
	]);
	await db.run(
		`insert into ocr_chunks
			(chunk_id, revision_id, variant, page, block, text, text_norm, checksum, normalization_version, ingest_generation)
		values
			('chunk-1', 'revision-1', 'raw', 1, 0, 'one', 'one', '${hash(21)}', 1, 'generation-raw-1'),
			('chunk-2', 'revision-1', 'raw', 1, 1, 'two', 'two', '${hash(22)}', 1, 'generation-raw-1'),
			('chunk-3', 'revision-1', 'normalized', 1, 0, 'one two', 'one two', '${hash(23)}', 1, 'generation-normalized-1'),
			('chunk-4', 'revision-2', 'raw', 1, 0, 'three', 'three', '${hash(24)}', 1, 'generation-raw-2')`
	);
}

describe('archive collection statistics', () => {
	it('counts whole-document text as a work, never as a scanned page', async () => {
		await seedCollection();
		// Page 0 is text extracted without page structure. Counting it as a page
		// would report an entire book as one covered page.
		await db.run(
			`insert into ocr_chunks
				(chunk_id, revision_id, variant, page, block, text, text_norm, checksum, normalization_version, ingest_generation)
			values
				('chunk-whole', 'revision-3', 'raw', 0, 0, 'whole book', 'whole book', '${hash(31)}', 1, 'generation-raw-3')`
		);
		await db.insert(schema.ocrIngestState).values([
			{
				revisionId: 'revision-3',
				variant: 'raw',
				contentHash: hash(31),
				pageCount: 1,
				activeGeneration: 'generation-raw-3',
				ingestedAt: new Date(9_000)
			}
		]);
		const stats = await getArchiveStats(db, 10_000);

		expect(stats.ocr.worksWithText).toBe(3);
		expect(stats.ocr.worksWithPageAlignedText).toBe(2);
		expect(stats.ocr.worksWithWholeDocumentText).toBe(1);
		expect(stats.ocr.pagesWithText).toBe(2);
	});

	it('returns aggregate shape with recorded coverage and freshness', async () => {
		await seedCollection();
		const stats = await getArchiveStats(db, 10_000);

		expect(stats).toMatchObject({
			totals: {
				works: 3,
				files: 3,
				currentRevisions: 3,
				storedObjects: 5,
				totalBytes: 22 * MIB + 300,
				deduplicatedBytes: 22 * MIB + 300,
				byteCoverage: { recordedRevisions: 6, unspecifiedRevisions: 0 }
			},
			pages: { total: 15, recordedRevisions: 2, unspecifiedRevisions: 1 },
			ocr: {
				worksWithText: 2,
				worksWithoutRecordedText: 1,
				worksWithPageAlignedText: 2,
				worksWithWholeDocumentText: 0,
				pagesWithText: 2,
				chunks: 4,
				variants: [
					{
						variant: 'normalized',
						works: 1,
						engines: { recordedWorks: 0, unspecifiedWorks: 1, values: [] }
					},
					{
						variant: 'raw',
						works: 2,
						engines: {
							recordedWorks: 2,
							unspecifiedWorks: 0,
							values: [{ engine: 'tesseract', works: 2 }]
						}
					}
				]
			},
			derivatives: {
				currentRevisions: 3,
				pageImages: { withRecordedDerivative: 1, withoutRecordedDerivative: 2 },
				linearizedPdf: { withRecordedDerivative: 1, withoutRecordedDerivative: 2 }
			},
			search: { enabledModes: ['phrase', 'regex', 'soft', 'similar'] },
			freshness: {
				mostRecentIngestAt: new Date(8_000).toISOString(),
				mostRecentApprovedRevision: {
					id: 'revision-linearized',
					approvedAt: new Date(5_000).toISOString()
				}
			}
		});
		expect(stats.distribution.size.values).toEqual([
			{ value: '0 B', count: 1 },
			{ value: '< 1 MiB', count: 0 },
			{ value: '1–<10 MiB', count: 1 },
			{ value: '10–<100 MiB', count: 1 },
			{ value: '100 MiB–<1 GiB', count: 0 },
			{ value: '≥ 1 GiB', count: 0 }
		]);
		expect(stats.distribution.era.values).toEqual([
			{ value: 'pre-1900', count: 1 },
			{ value: '1900s', count: 1 }
		]);
	});

	it('reports missing dialect metadata as unspecified', async () => {
		await seedCollection();
		const dialect = (await getArchiveStats(db, 10_000)).distribution.dialect;

		expect(dialect).toEqual({
			unit: 'works',
			total: 3,
			recorded: 1,
			unspecified: 2,
			values: [{ value: 'Saru', count: 1 }]
		});
	});

	it('requires an archive reader role at the route', async () => {
		await seedCollection();
		const { GET } = await import('../../../routes/api/archive/stats/+server');

		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/stats'),
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });

		env.ACCESS_SERVICE_TOKENS = 'stats-client:stats-secret';
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'service_token', value: 'stats-client' });
		const response = await GET({
			request: new Request('https://db.aynu.org/api/archive/stats', {
				headers: {
					'CF-Access-Client-Id': 'stats-client',
					'CF-Access-Client-Secret': 'stats-secret'
				}
			}),
			locals: { archiveDb: db }
		} as never);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('private, max-age=60');
		expect(await response.json()).toMatchObject({ totals: { works: 3 } });
	});

	it('bounds the cached query set to three statements', async () => {
		await seedCollection();
		const all = vi.spyOn(db, 'all');

		await getArchiveStats(db, 10_000);
		await getArchiveStats(db, 69_999);
		expect(all).toHaveBeenCalledTimes(3);

		await getArchiveStats(db, 70_001);
		expect(all).toHaveBeenCalledTimes(6);
	});
});
