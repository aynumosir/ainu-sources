import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';
import { ingestSections } from './ingest-sections';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

let db: Db;

beforeEach(async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ingest-sections-'));
	db = drizzle(createClient({ url: `file:${path.join(dir, 'test.db')}` }), { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	await db.insert(schema.user).values({ id: 'u1', name: 'U', email: 'u@example.test', emailVerified: true });
	await db.insert(schema.sources).values({ id: 'src', slug: 'work-one', title: 'Work One', type: 'book', humanDownload: true });
	await db.insert(schema.sourceFiles).values({ id: 'file-1', sourceId: 'src', role: 'scan', createdBy: 'u1' });
	await db.insert(schema.archiveBlobs).values({
		sha256: 'a'.repeat(64),
		bytes: 10,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 1,
		blobSha256: 'a'.repeat(64),
		originalFilename: 'work.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		pageCount: 200,
		isCurrent: true,
		submittedBy: 'u1',
		submittedAt: new Date(0)
	});
	// Folio offset drifts: printed 13 sits at scan 12, printed 100 at scan 103.
	await db.insert(schema.revisionPageFolios).values([
		{ revisionId: 'rev-1', page: 12, label: '13', value: 13, derivedFrom: 'pdftotext' },
		{ revisionId: 'rev-1', page: 103, label: '100', value: 100, derivedFrom: 'pdftotext' }
	]);
});

describe('ingest-sections', () => {
	it('resolves printed folios to scan positions through the drifting offset', async () => {
		const result = await ingestSections(db, {
			revisionId: 'rev-1',
			pages: 'printed',
			origin: 'toc',
			sections: [
				{ title: '序論', pageStart: 13 },
				{ title: '本論', pageStart: 100 }
			]
		});
		expect(result.inserted).toBe(2);
		const rows = await db
			.select({ ord: schema.revisionSections.ord, title: schema.revisionSections.title, pageStart: schema.revisionSections.pageStart })
			.from(schema.revisionSections)
			.where(eq(schema.revisionSections.revisionId, 'rev-1'))
			.orderBy(asc(schema.revisionSections.ord));
		expect(rows).toEqual([
			{ ord: 0, title: '序論', pageStart: 12 },
			{ ord: 1, title: '本論', pageStart: 103 }
		]);
	});

	it('takes a verified scan override where folio resolution cannot reach', async () => {
		await ingestSections(db, {
			revisionId: 'rev-1',
			pages: 'printed',
			origin: 'toc',
			sections: [
				{ title: '序論', pageStart: 13 },
				{ title: '無折丁の部扉', pageStart: 55, scanPageStart: 57 }
			]
		});
		const rows = await db
			.select({ title: schema.revisionSections.title, pageStart: schema.revisionSections.pageStart })
			.from(schema.revisionSections)
			.where(eq(schema.revisionSections.revisionId, 'rev-1'))
			.orderBy(asc(schema.revisionSections.ord));
		expect(rows).toEqual([
			{ title: '序論', pageStart: 12 },
			{ title: '無折丁の部扉', pageStart: 57 }
		]);
	});

	it('rejects a scan override in a file already counting scan pages', async () => {
		await expect(
			ingestSections(db, {
				revisionId: 'rev-1',
				pages: 'scan',
				origin: 'curated',
				sections: [{ title: '重複指定', pageStart: 10, scanPageStart: 11 }]
			})
		).rejects.toThrow(/only a printed-pages file can use/);
	});

	it('refuses a printed page with no detected folio rather than guessing', async () => {
		await expect(
			ingestSections(db, {
				revisionId: 'rev-1',
				pages: 'printed',
				origin: 'toc',
				sections: [{ title: '幻の章', pageStart: 55 }]
			})
		).rejects.toThrow(/no detected folio for printed page 55/);
	});

	it('refuses a section that ends before it starts, keeping prior sections intact', async () => {
		await ingestSections(db, {
			revisionId: 'rev-1',
			pages: 'scan',
			origin: 'curated',
			sections: [{ title: 'Kept', pageStart: 1, pageEnd: 40 }]
		});
		await expect(
			ingestSections(db, {
				revisionId: 'rev-1',
				pages: 'scan',
				origin: 'curated',
				sections: [{ title: '逆転', pageStart: 50, pageEnd: 40 }]
			})
		).rejects.toThrow(/ends on page 40 before it starts on page 50/);
		const rows = await db
			.select({ title: schema.revisionSections.title, pageEnd: schema.revisionSections.pageEnd })
			.from(schema.revisionSections)
			.where(eq(schema.revisionSections.revisionId, 'rev-1'));
		expect(rows).toEqual([{ title: 'Kept', pageEnd: 40 }]);
	});

	it('rejects an inverted page range at the database as well', async () => {
		await expect(
			db.insert(schema.revisionSections).values({
				revisionId: 'rev-1',
				ord: 0,
				title: '逆転',
				pageStart: 50,
				pageEnd: 40,
				origin: 'curated'
			})
		).rejects.toThrow();
	});

	it('refuses sections out of reading order', async () => {
		await expect(
			ingestSections(db, {
				revisionId: 'rev-1',
				pages: 'scan',
				origin: 'curated',
				sections: [
					{ title: '後', pageStart: 50 },
					{ title: '前', pageStart: 10 }
				]
			})
		).rejects.toThrow(/out of reading order/);
	});

	it('replaces the sections a revision already has', async () => {
		await ingestSections(db, {
			revisionId: 'rev-1',
			pages: 'scan',
			origin: 'headings',
			sections: [{ title: 'Old', pageStart: 1 }]
		});
		await ingestSections(db, {
			revisionId: 'rev-1',
			pages: 'scan',
			origin: 'curated',
			sections: [
				{ title: 'New A', pageStart: 1, pageEnd: 49 },
				{ title: 'New B', depth: 2, pageStart: 50 }
			]
		});
		const rows = await db
			.select({ title: schema.revisionSections.title, depth: schema.revisionSections.depth, pageEnd: schema.revisionSections.pageEnd, origin: schema.revisionSections.origin })
			.from(schema.revisionSections)
			.where(eq(schema.revisionSections.revisionId, 'rev-1'))
			.orderBy(asc(schema.revisionSections.ord));
		expect(rows).toEqual([
			{ title: 'New A', depth: 1, pageEnd: 49, origin: 'curated' },
			{ title: 'New B', depth: 2, pageEnd: null, origin: 'curated' }
		]);
	});
});
