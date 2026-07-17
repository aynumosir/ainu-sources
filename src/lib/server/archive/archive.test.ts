import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from '$lib/server/db/schema';
import { user } from '$lib/server/db/auth.schema';
import { recordArchiveEvent } from './audit';
import { archiveAuthzInternals, resolveArchivePrincipal } from './authz';
import { compareCursor, decodeCursor, encodeCursor } from './cursor';
import { issueArchiveCsrfToken, requireArchiveOrigin, verifyArchiveCsrfToken } from './csrf';
import { hmacSha256Hex } from './crypto';
import {
	approveRevision,
	capabilityExpiry,
	createUploadSession,
	getSourceFileById,
	issueCapability,
	listFiles,
	listSourceFiles,
	redeemCapability
} from './db';
import { ArchiveHttpError } from './errors';
import { renderManifest } from './manifest';
import { verifyMcpAssertion } from './mcp-assertion';
import { listOcrPages, searchOcr } from './ocr';
import { buildRangeResponse, quotedSha256Etag } from './range';
import { archiveMutationPrincipal } from './route';
import { archiveRoleAtLeast, type ArchivePrincipal } from './types';
import { ingestOcr } from '../../../../scripts/archive/ingest-ocr';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: `file:/tmp/archive-test-${crypto.randomUUID()}.db` });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

let db: Db;

const sha = 'a'.repeat(64);
const reviewer: ArchivePrincipal = {
	userId: 'reviewer',
	role: 'archive_reviewer',
	identity: { kind: 'github_login', value: 'reviewer' },
	authn: 'access_jwt'
};
const contributor: ArchivePrincipal = {
	userId: 'contributor',
	role: 'archive_contributor',
	identity: { kind: 'github_login', value: 'contributor' },
	authn: 'access_jwt'
};
const reader: ArchivePrincipal = {
	userId: 'reader',
	role: 'archive_reader',
	identity: { kind: 'github_login', value: 'reader' },
	authn: 'access_jwt'
};

beforeEach(async () => {
	db = await makeDb();
	for (const key of Object.keys(env)) delete env[key];
	env.ARCHIVE_CSRF_SECRET = 'csrf-secret';
	await db.insert(user).values([
		{ id: 'reviewer', name: 'Reviewer', email: 'reviewer@example.test' },
		{ id: 'contributor', name: 'Contributor', email: 'contributor@example.test' },
		{ id: 'reader', name: 'Reader', email: 'reader@example.test' }
	]);
});

async function seedRevision(status: 'pending' | 'approved' = 'pending', media = 'application/pdf') {
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
		checkoutPath: 'books/資料一.pdf',
		sortOrder: 10,
		createdBy: 'contributor'
	});
	await db.insert(schema.archiveBlobs).values({
		sha256: sha,
		bytes: 1234,
		detectedMediaType: media,
		storageState: 'verified',
		verifiedAt: new Date(),
		createdBy: 'contributor'
	});
	await db.insert(schema.fileRevisions).values({
		id: 'rev-1',
		sourceFileId: 'file-1',
		revisionNo: 1,
		blobSha256: sha,
		originalFilename: '資料一.pdf',
		declaredMediaType: 'application/pdf',
		artifactKind: 'original',
		pageCount: 12,
		reviewStatus: status,
		isCurrent: status === 'approved',
		submittedBy: 'contributor',
		submittedAt: new Date(1_000),
		reviewedBy: status === 'approved' ? 'reviewer' : null,
		reviewedAt: status === 'approved' ? new Date(2_000) : null
	});
}

async function buildMcpAssertionHeaders(
	secret: string,
	actor: string,
	ts = 1_000,
	nonce: string = crypto.randomUUID()
): Promise<Headers> {
	const bytes = new TextEncoder().encode(JSON.stringify({ caller: 'mcp', actor, ts, nonce }));
	return new Headers({
		'X-Archive-Assertion': bytesToBase64(bytes),
		'X-Archive-Signature': await hmacSha256Hex(secret, bytes)
	});
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

describe('archive pure helpers', () => {
	it('orders archive roles without granting site roles', () => {
		expect(archiveRoleAtLeast('archive_reviewer', 'archive_reader')).toBe(true);
		expect(archiveRoleAtLeast('archive_reader', 'archive_reviewer')).toBe(false);
		expect(archiveRoleAtLeast('archive_admin', 'archive_reviewer')).toBe(true);
	});

	it('round-trips cursors and preserves ordering comparisons', () => {
		const a = { updatedAt: '2026-01-01T00:00:00.000Z', id: 'a' };
		const b = { updatedAt: '2026-01-01T00:00:00.000Z', id: 'b' };
		expect(decodeCursor(encodeCursor(a))).toEqual(a);
		expect(compareCursor(a, b)).toBeLessThan(0);
	});

	it('parses byte ranges and returns 416 for malformed input', () => {
		const etag = quotedSha256Etag(sha);
		expect(buildRangeResponse('bytes=10-19', null, 100, etag)).toMatchObject({
			status: 206,
			contentLength: 10,
			contentRange: 'bytes 10-19/100'
		});
		expect(buildRangeResponse('bytes=-5', null, 100, etag)).toMatchObject({
			status: 206,
			contentRange: 'bytes 95-99/100'
		});
		expect(buildRangeResponse('bytes=100-101', null, 100, etag)).toEqual({
			status: 416,
			contentRange: 'bytes */100'
		});
		expect(buildRangeResponse('bytes=10-19', '"different"', 100, etag)).toMatchObject({
			status: 200,
			contentLength: 100
		});
	});

	it('caps capability TTL at 120 seconds', () => {
		const now = new Date('2026-01-01T00:00:00.000Z');
		expect(capabilityExpiry(999, now).toISOString()).toBe('2026-01-01T00:02:00.000Z');
	});

	it('checks CSRF origin exactly and binds tokens to users', async () => {
		env.ARCHIVE_ORIGIN = 'https://archive.aynu.org';
		requireArchiveOrigin(new Request('https://archive.aynu.org/api', { headers: { origin: 'https://archive.aynu.org' } }));
		expect(() =>
			requireArchiveOrigin(new Request('https://archive.aynu.org/api', { headers: { origin: 'http://archive.aynu.org' } }))
		).toThrow(ArchiveHttpError);
		const token = await issueArchiveCsrfToken('reader', new Date('2026-01-01T00:00:00.000Z'));
		await expect(verifyArchiveCsrfToken(token, 'reader', new Date('2026-01-01T00:01:00.000Z'))).resolves.toBeUndefined();
		await expect(verifyArchiveCsrfToken(token, 'reviewer', new Date('2026-01-01T00:01:00.000Z'))).rejects.toThrow(ArchiveHttpError);
	});

	it('verifies MCP assertions with raw JSON HMAC headers', async () => {
		const secret = 'mcp-secret';
		const headers = await buildMcpAssertionHeaders(secret, 'octocat', 1_000, 'nonce-1');
		await expect(verifyMcpAssertion(headers, secret, { now: 1_000, nonceStore: new Map() })).resolves.toEqual({
			ok: true,
			actor: 'octocat'
		});

		const tampered = new Headers(headers);
		const signature = tampered.get('X-Archive-Signature') ?? '';
		tampered.set('X-Archive-Signature', `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`);
		await expect(verifyMcpAssertion(tampered, secret, { now: 1_000, nonceStore: new Map() })).resolves.toMatchObject({
			ok: false
		});

		const stale = await buildMcpAssertionHeaders(secret, 'octocat', 900, 'nonce-2');
		await expect(verifyMcpAssertion(stale, secret, { now: 1_000, nonceStore: new Map() })).resolves.toMatchObject({
			ok: false
		});

		const nonceStore = new Map<string, number>();
		const replay = await buildMcpAssertionHeaders(secret, 'octocat', 1_000, 'nonce-3');
		await expect(verifyMcpAssertion(replay, secret, { now: 1_000, nonceStore })).resolves.toMatchObject({ ok: true });
		await expect(verifyMcpAssertion(replay, secret, { now: 1_001, nonceStore })).resolves.toMatchObject({ ok: false });
	});
});

describe('archive DB flows', () => {
	it('resolves only explicit archive roles from app_user_roles', async () => {
		await db.insert(schema.appUserRoles).values([
			{ userId: 'reader', role: 'archive_reader' },
			{ userId: 'reviewer', role: 'admin' }
		]);
		await expect(archiveAuthzInternals.roleForUser(db, 'reader')).resolves.toBe('archive_reader');
		await expect(archiveAuthzInternals.roleForUser(db, 'reviewer')).resolves.toBeNull();
		await expect(archiveAuthzInternals.roleForUser(db, 'missing')).resolves.toBeNull();
	});

	it('caps MCP assertion principals at archive_reader', async () => {
		env.ASSERTION_KEY_MCP = 'mcp-secret';
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_admin' });
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		const headers = await buildMcpAssertionHeaders(env.ASSERTION_KEY_MCP, 'octocat', Math.floor(Date.now() / 1000), 'reader-ceiling');
		const request = new Request('https://db.aynu.org/api/archive/files', { headers });
		const principal = await resolveArchivePrincipal(request, db);
		expect(principal).toMatchObject({ userId: 'reader', role: 'archive_reader', authn: 'mcp_assertion' });
	});

	it('rejects MCP assertion principals for mutating route guards', async () => {
		env.ASSERTION_KEY_MCP = 'mcp-secret';
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		const headers = await buildMcpAssertionHeaders(env.ASSERTION_KEY_MCP, 'octocat', Math.floor(Date.now() / 1000), 'mutation-denial');
		const request = new Request('https://db.aynu.org/api/archive/review', { method: 'POST', headers });
		await expect(archiveMutationPrincipal(request, 'archive_reader', db)).rejects.toMatchObject({ status: 403 });
	});

	it('rejects MCP assertion principals for capability issuance', async () => {
		await seedRevision('approved');
		await expect(
			issueCapability(db, 'rev-1', {
				userId: 'contributor',
				role: 'archive_reader',
				identity: { kind: 'github_login', value: 'contributor' },
				authn: 'mcp_assertion'
			})
		).rejects.toThrow('assertion-authenticated principals cannot issue capabilities');
	});

	it('creates upload session and file slot in one transaction', async () => {
		await db.insert(schema.sources).values({
			id: 'source-1',
			slug: 'source-one',
			title: 'Source One',
			category: 'primary',
			type: 'book',
			humanDownload: true
		});
		const result = await createUploadSession(db, contributor, {
			sourceSlug: 'source-one',
			role: 'scan',
			bytes: 42,
			sha256: sha,
			declaredMediaType: 'application/pdf'
		});
		expect(result.session.sourceFileId).toBe(result.sourceFile.id);
		expect((await db.select().from(schema.sourceFiles)).length).toBe(1);
		expect((await db.select().from(schema.uploadSessions)).length).toBe(1);
	});

	it('approves a pending revision transactionally', async () => {
		await seedRevision('pending');
		const approved = await approveRevision(db, 'rev-1', reviewer);
		expect(approved.reviewStatus).toBe('approved');
		expect(approved.isCurrent).toBe(true);
		const events = await db.select().from(schema.sourceLifecycleEvents);
		expect(events.some((e) => e.eventType === 'revision_approved' && e.entityId === 'rev-1')).toBe(true);
	});

	it('rejects invalid approval states', async () => {
		await seedRevision('approved');
		await expect(approveRevision(db, 'rev-1', reviewer)).rejects.toThrow('revision is not pending');
	});

	it('rejects reviewer-is-submitter and media-type mismatch approvals', async () => {
		await seedRevision('pending');
		await expect(approveRevision(db, 'rev-1', { ...reviewer, userId: 'contributor' })).rejects.toThrow('reviewer must differ');
		await db.update(schema.archiveBlobs).set({ detectedMediaType: 'application/zip' }).where(eq(schema.archiveBlobs.sha256, sha));
		await expect(approveRevision(db, 'rev-1', reviewer)).rejects.toThrow('media type');
	});

	it('atomically caps capability redemption', async () => {
		await seedRevision('approved');
		const cap = await issueCapability(db, 'rev-1', reviewer, 120);
		const attempts = await Promise.allSettled([
			redeemCapability(db, cap.bearer, 'all'),
			redeemCapability(db, cap.bearer, 'all')
		]);
		expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		const [token] = await db.select().from(schema.capabilityTokens).where(eq(schema.capabilityTokens.jti, cap.bearer));
		expect(token.bytesServed).toBe(token.maxBytes);
	});

	it('ingests OCR pages, records preferred coverage, and searches visible text', async () => {
		await seedRevision('approved');
		const ainuRoot = await mkdtemp(join(tmpdir(), 'archive-ocr-'));
		try {
			const ocrDir = join(ainuRoot, 'ainu-grammar', 'books', 'ocr');
			await mkdir(ocrDir, { recursive: true });
			await writeFile(
				join(ocrDir, '資料一.gemini.txt'),
				'--- page 1 ---\nfirst page text\n--- page 2 ---\nkamuy search target\n'
			);
			const summary = await ingestOcr(db, { ainuRoot, dryRun: false, now: new Date('2026-01-01T00:00:00.000Z') });
			expect(summary).toMatchObject({ ingested: 1, unchanged: 0, skippedNoMatch: 0, skippedNoRevision: 0 });
			expect(await listOcrPages(db, 'rev-1', 'gemini')).toEqual([
				{ revisionId: 'rev-1', variant: 'gemini', page: 1, text: 'first page text' },
				{ revisionId: 'rev-1', variant: 'gemini', page: 2, text: 'kamuy search target' }
			]);
			const [coverage] = await db
				.select()
				.from(schema.revisionOcrCoverage)
				.where(and(eq(schema.revisionOcrCoverage.revisionId, 'rev-1'), eq(schema.revisionOcrCoverage.variant, 'gemini')));
			expect(coverage).toMatchObject({ status: 'complete', tool: 'gemini', preferred: true });
			const result = await searchOcr(db, reader, { q: 'kamuy' });
			expect(result.items).toHaveLength(1);
			expect(result.items[0]).toMatchObject({
				source: { slug: 'source-one', title: '資料一' },
				revisionId: 'rev-1',
				page: 2,
				variant: 'gemini'
			});
		} finally {
			await rm(ainuRoot, { recursive: true, force: true });
		}
	});

	it('validates source file role filters', async () => {
		await seedRevision('approved');
		await expect(listSourceFiles(db, 'source-one', reviewer, { role: 'bad-role' })).rejects.toMatchObject({
			status: 400
		});
		await expect(listFiles(db, null, null, 50, { role: 'bad-role' })).rejects.toMatchObject({ status: 400 });
	});

	it('includes approved revision history only when requested', async () => {
		await seedRevision('approved');
		await db.update(schema.fileRevisions).set({ isCurrent: false }).where(eq(schema.fileRevisions.id, 'rev-1'));
		await db.insert(schema.archiveBlobs).values({
			sha256: 'b'.repeat(64),
			bytes: 4321,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date()
		});
		await db.insert(schema.fileRevisions).values({
			id: 'rev-2',
			sourceFileId: 'file-1',
			revisionNo: 2,
			blobSha256: 'b'.repeat(64),
			originalFilename: '資料一.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			pageCount: 12,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(3_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(4_000)
		});

		expect((await listSourceFiles(db, 'source-one', reviewer)).map((row) => row.revisionId)).toEqual(['rev-2']);
		expect((await listSourceFiles(db, 'source-one', reviewer, { includeHistory: true })).map((row) => row.revisionId)).toEqual([
			'rev-2',
			'rev-1'
		]);
		expect((await listFiles(db, null, null)).items.map((row) => row.revisionId)).toEqual(['rev-2']);
		expect((await listFiles(db, null, null, 50, { includeHistory: true })).items.map((row) => row.revisionId)).toEqual([
			'rev-1',
			'rev-2'
		]);
	});

	it('resolves file ids to source metadata and current revisions', async () => {
		await seedRevision('approved');
		await expect(getSourceFileById(db, 'file-1', reviewer)).resolves.toMatchObject({
			fileId: 'file-1',
			sourceId: 'source-1',
			sourceSlug: 'source-one',
			role: 'scan',
			checkoutPath: 'books/資料一.pdf',
			currentRevisionId: 'rev-1',
			pendingRevisionId: null
		});
	});

	it('returns null currentRevisionId for file ids without a current revision', async () => {
		await seedRevision('approved');
		await db.insert(schema.sourceFiles).values({
			id: 'file-empty',
			sourceId: 'source-1',
			role: 'supplement',
			checkoutRepoId: 'repo-1',
			checkoutPath: 'books/補遺.pdf',
			sortOrder: 20
		});
		await expect(getSourceFileById(db, 'file-empty', reviewer)).resolves.toMatchObject({
			fileId: 'file-empty',
			currentRevisionId: null,
			pendingRevisionId: null
		});
	});

	it('writes source-shaped and archive-shaped event ledger rows', async () => {
		await db.insert(schema.sources).values({
			id: 'source-1',
			slug: 'source-one',
			title: 'Source One',
			category: 'primary',
			type: 'book'
		});
		await db.insert(schema.sourceLifecycleEvents).values({
			sourceId: 'source-1',
			eventType: 'status_change',
			toStatus: 'active'
		});
		await recordArchiveEvent(db, {
			entityType: 'user',
			entityId: 'reader',
			eventType: 'membership_deactivated',
			actor: 'reader'
		});
		const rows = await db.select().from(schema.sourceLifecycleEvents);
		expect(rows.some((row) => row.sourceId === 'source-1')).toBe(true);
		expect(rows.some((row) => row.entityType === 'user' && row.entityId === 'reader')).toBe(true);
	});

	it('renders manifest JSONL with field order and UTF-8 path sorting', async () => {
		await seedRevision('approved');
		await db.insert(schema.sourceFiles).values({
			id: 'file-2',
			sourceId: 'source-1',
			role: 'scan',
			checkoutRepoId: 'repo-1',
			checkoutPath: 'books/A.pdf',
			sortOrder: 20
		});
		await db.insert(schema.archiveBlobs).values({
			sha256: 'b'.repeat(64),
			bytes: 5,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date()
		});
		await db.insert(schema.fileRevisions).values({
			id: 'rev-2',
			sourceFileId: 'file-2',
			revisionNo: 1,
			blobSha256: 'b'.repeat(64),
			originalFilename: 'A.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			pageCount: 1,
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(),
			reviewedBy: 'reviewer',
			reviewedAt: new Date()
		});
		const { body } = await renderManifest(db, 'books');
		const lines = body.trim().split('\n');
		expect(JSON.parse(lines[0]).path).toBe('books/A.pdf');
		expect(Object.keys(JSON.parse(lines[0]))).toEqual([
			'schema',
			'snapshot_id',
			'path',
			'source_slug',
			'file_id',
			'revision_id',
			'role',
			'sort_order',
			'sha256',
			'bytes',
			'media_type',
			'pages'
		]);
	});
});
