/**
 * Regressions that reached production.
 *
 * Each case here corresponds to a fault that was shipped and observed live: a
 * page route reading a table a migration had dropped, an upstream failure
 * reported as empty content, and search results for text that carries no page
 * structure. Unit coverage existed for the helpers underneath all three; what
 * was missing was any test that ran the code paths a reader actually reaches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import { replaceOcrPages, searchArchive } from './ocr';
import { resolveArchivePrincipal } from './authz';
import { streamRevisionContent } from './stream';

let db: LibSQLDatabase<typeof schema>;

async function makeDb() {
	const client = createClient({ url: ':memory:' });
	const instance = drizzle(client, { schema });
	await migrate(instance, {
		migrationsFolder: fileURLToPath(new URL('../../../../drizzle', import.meta.url))
	});
	return instance;
}

async function seed(): Promise<void> {
	env.ACCESS_SERVICE_TOKENS = 'reader-client:reader-secret';
	env.ASSERTION_KEY_SOURCES = 'assertion-secret';
	await db.insert(user).values([{ id: 'reader', name: 'Reader', email: 'reader@example.test' }]);
	await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
	await db.insert(schema.userIdentities).values({
		userId: 'reader',
		kind: 'service_token',
		value: 'reader-client'
	});
	await db.insert(schema.sources).values({
		id: 'source-1',
		slug: 'source-one',
		title: '資料一',
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
		checkoutPath: 'books/one.pdf',
		createdBy: 'reader'
	});
	await db.insert(schema.archiveBlobs).values({
		sha256: 'b'.repeat(64),
		bytes: 1234,
		detectedMediaType: 'application/pdf',
		storageState: 'verified',
		verifiedAt: new Date()
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 1,
		blobSha256: 'b'.repeat(64),
		originalFilename: 'one.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		pageCount: 12,
		reviewStatus: 'approved',
		isCurrent: true,
		submittedBy: 'reader',
		reviewedBy: 'reader',
		reviewedAt: new Date()
	});
	await db.insert(schema.revisionOcrCoverage).values({
		revisionId: 'rev-1',
		variant: 'pdftotext',
		status: 'complete',
		preferred: true,
		tool: 'pdftotext'
	});
}

async function readerPrincipal() {
	const principal = await resolveArchivePrincipal(
		new Request('https://db.aynu.org/api/archive/search', {
			headers: {
				'CF-Access-Client-Id': 'reader-client',
				'CF-Access-Client-Secret': 'reader-secret'
			}
		}),
		db
	);
	if (!principal) throw new Error('reader principal did not resolve');
	return principal;
}

beforeEach(async () => {
	db = await makeDb();
	await seed();
});

describe('schema drift', () => {
	it('has no ocr_pages table for a route to read', async () => {
		// A page route queried this table after migration 0013 dropped it, and
		// every work page returned 500. Nothing failed at build time.
		const tables = await db.all<{ name: string }>(
			sql`select name from sqlite_master where type = 'table'`
		);
		expect(tables.map((row) => row.name)).not.toContain('ocr_pages');
	});

	it('serves the page-count query the work routes actually run', async () => {
		await replaceOcrPages(db, 'rev-1', 'pdftotext', [
			{ page: 1, text: 'first' },
			{ page: 2, text: 'second' }
		]);
		const rows = await db.all<{ variant: string; pageCount: number }>(sql`
			select c.variant as variant,
				cast(count(distinct cast(c.page as integer)) as integer) as pageCount
			from ocr_chunks c
			inner join ocr_ingest_state s
				on s.revision_id = c.revision_id
				and s.variant = c.variant
				and s.active_generation = c.ingest_generation
			where c.revision_id = 'rev-1'
			group by c.variant
		`);
		expect(rows).toEqual([{ variant: 'pdftotext', pageCount: 2 }]);
	});
});

describe('whole-document search results', () => {
	it('marks a page-0 hit as a whole document rather than page zero', async () => {
		await replaceOcrPages(db, 'rev-1', 'pdftotext', [{ page: 0, text: 'kamuy in one block' }]);
		const principal = await readerPrincipal();
		expect(principal.role).toBe('archive_reader');

		const result = await searchArchive(db, principal, { q: 'kamuy', mode: 'phrase' });
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({ page: 0, wholeDocument: true });
	});

	it('refuses a similar-page search against text with no page structure', async () => {
		await replaceOcrPages(db, 'rev-1', 'pdftotext', [{ page: 0, text: 'kamuy in one block' }]);
		const principal = await readerPrincipal();

		await expect(
			searchArchive(db, principal, { q: 'rev-1:0', mode: 'similar' })
		).rejects.toMatchObject({ status: 422 });
	});
});

describe('upstream content failures', () => {
	const revision = {
		id: 'rev-1',
		sha256: 'b'.repeat(64),
		bytes: 1234,
		originalFilename: 'one.pdf'
	};
	const request = new Request('https://db.aynu.org/api/archive/revisions/rev-1/content');

	function fetcherReturning(status: number) {
		return {
			async fetch() {
				return new Response(status === 200 ? 'body' : null, { status });
			}
		};
	}

	it('reports a missing blob as 404 rather than an empty success', async () => {
		// This previously returned 200 with the database's byte length and no
		// body, so a reader saw a truncated file instead of an error.
		await expect(
			streamRevisionContent(fetcherReturning(404) as never, 'reader', request, revision, 'GET')
		).rejects.toMatchObject({ status: 404 });
	});

	it('reports a failing content store as 502', async () => {
		await expect(
			streamRevisionContent(fetcherReturning(500) as never, 'reader', request, revision, 'GET')
		).rejects.toMatchObject({ status: 502 });
	});

	it('refuses a revision with no blob instead of streaming nothing', async () => {
		const response = await streamRevisionContent(
			fetcherReturning(200) as never,
			'reader',
			request,
			{ ...revision, sha256: null },
			'GET'
		);
		expect(response.status).toBe(404);
	});
});

describe('page navigation', () => {
	it('does not clamp a requested page when the count is unrecorded', async () => {
		// A revision with no recorded page count used to send every request to
		// page 1, so a citation for page 50 named the cover instead.
		const { clampPageForTest } = await import('$lib/archive/work-data.server');
		expect(clampPageForTest(50, null)).toBe(50);
		expect(clampPageForTest(50, 30)).toBe(30);
		expect(clampPageForTest(0, 30)).toBe(1);
	});
});
