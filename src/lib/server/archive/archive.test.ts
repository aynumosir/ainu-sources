import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import { archiveAuthzInternals, resolveArchiveIdentity, resolveArchivePrincipal, resolveFromAppSession } from './authz';
import { compareCursor, decodeCursor, encodeCursor } from './cursor';
import { issueArchiveCsrfToken, requireArchiveMutationGuards, requireArchiveOrigin, verifyArchiveCsrfToken } from './csrf';
import { hmacSha256Hex } from './crypto';
import { captureGithubAccountEvent, rememberGithubProfileLogin } from './github-login-capture';
import {
	approveRevision,
	capabilityExpiry,
	createUploadSession,
	getSourceFileById,
	getUsageSummary,
	issueCapability,
	listArchiveUsers,
	listFiles,
	listPendingReview,
	listSourceFiles,
	listUploadSessions,
	reconcileUploadFinalization,
	redeemCapability,
	rejectRevision,
	setArchiveUserRole
} from './db';
import { ArchiveHttpError } from './errors';
import { renderManifest } from './manifest';
import { verifyMcpAssertion } from './mcp-assertion';
import { listOcrPages, replaceOcrPages, searchOcr } from './ocr';
import { buildRangeResponse, quotedSha256Etag } from './range';
import { archiveMutationPrincipal, throwArchiveError } from './route';
import { archiveRoleAtLeast, type ArchivePrincipal } from './types';
import { ingestOcr } from '../../../../scripts/archive/ingest-ocr';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));

type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const url = `file:/tmp/archive-test-${crypto.randomUUID()}.db`;
	env.DATABASE_URL = url;
	const client = createClient({ url });
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
const admin: ArchivePrincipal = {
	userId: 'admin',
	role: 'archive_admin',
	identity: { kind: 'github_login', value: 'admin' },
	authn: 'access_jwt'
};

beforeEach(async () => {
	for (const key of Object.keys(env)) delete env[key];
	archiveAuthzInternals.setAppSessionLookupForTest(async () => null);
	db = await makeDb();
	env.ARCHIVE_CSRF_SECRET = 'csrf-secret';
	await db.insert(user).values([
		{ id: 'reviewer', name: 'Reviewer', email: 'reviewer@example.test' },
		{ id: 'contributor', name: 'Contributor', email: 'contributor@example.test' },
		{ id: 'reader', name: 'Reader', email: 'reader@example.test' },
		{ id: 'admin', name: 'Admin', email: 'admin@example.test' },
		{ id: 'other', name: 'Other', email: 'other@example.test' }
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

async function seedUploadSource(slug = 'source-one') {
	await db.insert(schema.sources).values({
		id: `${slug}-id`,
		slug,
		title: 'Source One',
		category: 'primary',
		type: 'book',
		humanDownload: true
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

async function seedServicePrincipal(
	userId: string,
	role: schema.AppUserRole['role'],
	clientId = `${userId}-client`,
	secret = `${userId}-secret`
): Promise<{ auth: Headers; mutation: Headers }> {
	env.ACCESS_SERVICE_TOKENS = `${clientId}:${secret}`;
	await db.insert(schema.appUserRoles).values({ userId, role });
	await db.insert(schema.userIdentities).values({ userId, kind: 'service_token', value: clientId });
	const auth = new Headers({
		'CF-Access-Client-Id': clientId,
		'CF-Access-Client-Secret': secret
	});
	const mutation = new Headers(auth);
	mutation.set('Origin', 'https://archive.aynu.org');
	mutation.set('Content-Type', 'application/json');
	mutation.set('X-Archive-CSRF', await issueArchiveCsrfToken(userId));
	return { auth, mutation };
}

async function importRoute<T>(path: string): Promise<T> {
	return (await import(path)) as T;
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

	it('resolves app sessions from direct archive roles', async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'reader', email: 'reader@example.test' }));
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		const request = new Request('https://db.aynu.org/archive');
		const principal = await resolveFromAppSession(request, db);
		expect(principal).toMatchObject({
			userId: 'reader',
			role: 'archive_reader',
			authn: 'app_session',
			identity: { kind: 'app_session', value: 'reader@example.test' },
			email: 'reader@example.test'
		});
	});

	it('resolves the production owner app session from a direct archive_admin role', async () => {
		const owner = {
			id: 'UoIQf9NLeEV092FnQ51jDZqXtjLm5Ibm',
			name: 'Owner',
			email: 'mkpoli@mkpo.li'
		};
		await db.insert(user).values(owner);
		await db.insert(schema.appUserRoles).values({ userId: owner.id, role: 'archive_admin' });
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: owner.id, email: owner.email }));

		const principal = await resolveFromAppSession(new Request('https://db.aynu.org/archive'), db);

		expect(principal).toMatchObject({
			userId: owner.id,
			role: 'archive_admin',
			authn: 'app_session',
			identity: { kind: 'app_session', value: owner.email },
			email: owner.email
		});
	});

	it('resolves app sessions through cached GitHub login claims owned by another archive user', async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'other', email: 'other@example.test' }));
		await db.insert(schema.githubLoginCache).values({ userId: 'other', login: 'octocat' });
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reviewer' });
		const request = new Request('https://db.aynu.org/archive');
		const principal = await resolveFromAppSession(request, db);
		expect(principal).toMatchObject({
			userId: 'reader',
			role: 'archive_reviewer',
			authn: 'app_session',
			identity: { kind: 'github_login', value: 'octocat', userId: 'reader' },
			email: 'other@example.test'
		});
	});

	it('returns null for missing app sessions and unresolved app-session identities', async () => {
		const request = new Request('https://db.aynu.org/archive');
		await expect(resolveFromAppSession(request, db)).resolves.toBeNull();

		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'other', email: 'other@example.test' }));
		await expect(resolveFromAppSession(request, db)).resolves.toBeNull();

		await db.insert(schema.githubLoginCache).values({ userId: 'other', login: 'missing-login' });
		await expect(resolveFromAppSession(request, db)).resolves.toBeNull();
	});

	it('records GitHub login cache while preserving a pre-provisioned archive identity claim', async () => {
		await db.insert(user).values([
			{ id: 'synthetic-1', name: 'Synthetic User', email: 'synthetic@example.test' },
			{ id: 'new-user-1', name: 'New User', email: 'new-user@example.test' }
		]);
		await db.insert(schema.userIdentities).values({ kind: 'github_login', value: 'octocat', userId: 'synthetic-1' });
		await db.insert(schema.appUserRoles).values({ userId: 'synthetic-1', role: 'archive_reviewer' });

		rememberGithubProfileLogin('gh-numeric-1', 'octocat');
		await captureGithubAccountEvent(
			{ id: 'acct-1', accountId: 'gh-numeric-1', providerId: 'github', userId: 'new-user-1' },
			db
		);

		const [cached] = await db.select().from(schema.githubLoginCache).where(eq(schema.githubLoginCache.userId, 'new-user-1'));
		expect(cached).toMatchObject({ userId: 'new-user-1', login: 'octocat' });
		const identities = await db
			.select()
			.from(schema.userIdentities)
			.where(and(eq(schema.userIdentities.kind, 'github_login'), eq(schema.userIdentities.value, 'octocat')));
		expect(identities).toEqual([{ kind: 'github_login', value: 'octocat', userId: 'synthetic-1', createdAt: expect.any(Date) }]);
		const [event] = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'github_login_claim_conflict'));
		expect(event).toMatchObject({
			entityType: 'user',
			entityId: 'new-user-1',
			eventType: 'github_login_claim_conflict',
			actor: 'new-user-1',
			details: { login: 'octocat', claimedBy: 'synthetic-1' }
		});

		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({
			id: 'new-user-1',
			email: 'new-user@example.test'
		}));
		const principal = await resolveFromAppSession(new Request('https://db.aynu.org/archive'), db);
		expect(principal).toMatchObject({ userId: 'synthetic-1', role: 'archive_reviewer', authn: 'app_session' });
		await expect(resolveArchiveIdentity(new Request('https://db.aynu.org/archive'), db)).resolves.toEqual({ login: 'octocat' });
	});

	it('keeps GitHub login capture idempotent for repeated OAuth completions', async () => {
		rememberGithubProfileLogin('gh-numeric-reader', 'octocat');
		await captureGithubAccountEvent(
			{ id: 'acct-reader', accountId: 'gh-numeric-reader', providerId: 'github', userId: 'reader' },
			db
		);
		rememberGithubProfileLogin('gh-numeric-reader', 'octocat');
		await captureGithubAccountEvent(
			{ id: 'acct-reader', accountId: 'gh-numeric-reader', providerId: 'github', userId: 'reader' },
			db
		);

		const identities = await db
			.select()
			.from(schema.userIdentities)
			.where(and(eq(schema.userIdentities.kind, 'github_login'), eq(schema.userIdentities.value, 'octocat')));
		expect(identities).toHaveLength(1);
		expect(identities[0].userId).toBe('reader');
		const events = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'github_login_claim_conflict'));
		expect(events).toHaveLength(0);
	});

	it('auto-grants contributor role for roleless public org members on GitHub login capture', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
		rememberGithubProfileLogin('gh-numeric-other', 'public-member');
		await captureGithubAccountEvent(
			{ id: 'acct-other', accountId: 'gh-numeric-other', providerId: 'github', userId: 'other' },
			db,
			fetchMock
		);

		const [role] = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'other'));
		expect(role).toMatchObject({ userId: 'other', role: 'archive_contributor' });
		const [event] = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'org_membership_auto_grant'));
		expect(event).toMatchObject({
			entityType: 'user',
			entityId: 'other',
			eventType: 'org_membership_auto_grant',
			actor: 'other',
			details: { login: 'public-member', org: 'aynumosir' }
		});
	});

	it('does not overwrite an existing role during GitHub org auto-grant', async () => {
		await db.insert(schema.appUserRoles).values({ userId: 'other', role: 'archive_reviewer' });
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
		rememberGithubProfileLogin('gh-numeric-existing-role', 'public-member');
		await captureGithubAccountEvent(
			{ id: 'acct-existing-role', accountId: 'gh-numeric-existing-role', providerId: 'github', userId: 'other' },
			db,
			fetchMock
		);

		const [role] = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'other'));
		expect(role.role).toBe('archive_reviewer');
		const events = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'org_membership_auto_grant'));
		expect(events).toHaveLength(0);
	});

	it('keeps login capture when the GitHub org check fails', async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		rememberGithubProfileLogin('gh-numeric-failure', 'network-failure');
		await expect(
			captureGithubAccountEvent(
				{ id: 'acct-failure', accountId: 'gh-numeric-failure', providerId: 'github', userId: 'other' },
				db,
				fetchMock
			)
		).resolves.toBeUndefined();

		const roles = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'other'));
		expect(roles).toHaveLength(0);
		const [identity] = await db
			.select()
			.from(schema.userIdentities)
			.where(and(eq(schema.userIdentities.kind, 'github_login'), eq(schema.userIdentities.value, 'network-failure')));
		expect(identity).toMatchObject({ userId: 'other' });
		const [cached] = await db.select().from(schema.githubLoginCache).where(eq(schema.githubLoginCache.userId, 'other'));
		expect(cached).toMatchObject({ login: 'network-failure' });
		const events = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'org_membership_auto_grant'));
		expect(events).toHaveLength(0);
	});

	it('skips GitHub org auto-grant for non-member responses', async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
		rememberGithubProfileLogin('gh-numeric-non-member', 'non-member');
		await captureGithubAccountEvent(
			{ id: 'acct-non-member', accountId: 'gh-numeric-non-member', providerId: 'github', userId: 'other' },
			db,
			fetchMock
		);

		const roles = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'other'));
		expect(roles).toHaveLength(0);
		const events = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'org_membership_auto_grant'));
		expect(events).toHaveLength(0);
	});

	it('lists archive users with roles and merged login identities', async () => {
		await db.insert(schema.appUserRoles).values([
			{ userId: 'reader', role: 'archive_reader' },
			{ userId: 'contributor', role: 'archive_contributor' },
			{ userId: 'reviewer', role: 'editor' }
		]);
		await db.insert(schema.userIdentities).values([
			{ userId: 'reader', kind: 'github_login', value: 'preprovisioned-reader' },
			{ userId: 'reader', kind: 'service_token', value: 'reader-service' },
			{ userId: 'contributor', kind: 'github_login', value: 'identity-contributor' }
		]);
		await db.insert(schema.githubLoginCache).values({ userId: 'contributor', login: 'cached-contributor' });

		const rows = await listArchiveUsers(db);
		const readerRow = rows.find((row) => row.userId === 'reader');
		const contributorRow = rows.find((row) => row.userId === 'contributor');
		const reviewerRow = rows.find((row) => row.userId === 'reviewer');

		expect(readerRow).toMatchObject({
			userId: 'reader',
			name: 'Reader',
			email: 'reader@example.test',
			role: 'archive_reader',
			login: 'preprovisioned-reader',
			serviceToken: 'reader-service'
		});
		expect(readerRow?.roleUpdatedAt).toMatch(/Z$/u);
		expect(contributorRow).toMatchObject({
			role: 'archive_contributor',
			login: 'cached-contributor',
			serviceToken: null
		});
		expect(reviewerRow).toMatchObject({ role: null, login: null, serviceToken: null, roleUpdatedAt: null });
	});

	it('grants an archive role and audits the previous null role', async () => {
		await expect(setArchiveUserRole(db, 'other', 'archive_reader', admin)).resolves.toEqual({
			userId: 'other',
			role: 'archive_reader'
		});
		const [role] = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'other'));
		expect(role).toMatchObject({ userId: 'other', role: 'archive_reader' });
		const [event] = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'archive_role_changed'));
		expect(event).toMatchObject({
			entityType: 'user',
			entityId: 'other',
			actor: 'admin',
			details: { previousRole: null, newRole: 'archive_reader' }
		});
	});

	it('changes an existing archive role and records previous and new roles', async () => {
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		await setArchiveUserRole(db, 'reader', 'archive_reviewer', admin);
		const [role] = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'reader'));
		expect(role.role).toBe('archive_reviewer');
		const [event] = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'archive_role_changed'));
		expect(event.details).toEqual({ previousRole: 'archive_reader', newRole: 'archive_reviewer' });
	});

	it('removes a role row without touching other user rows', async () => {
		await db.insert(schema.appUserRoles).values([
			{ userId: 'reader', role: 'archive_reader' },
			{ userId: 'contributor', role: 'archive_contributor' }
		]);
		await setArchiveUserRole(db, 'reader', null, admin);
		expect(await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'reader'))).toHaveLength(0);
		expect(await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'contributor'))).toHaveLength(1);
		const [event] = await db
			.select()
			.from(schema.sourceLifecycleEvents)
			.where(eq(schema.sourceLifecycleEvents.eventType, 'archive_role_changed'));
		expect(event.details).toEqual({ previousRole: 'archive_reader', newRole: null });
	});

	it('returns 404 for a nonexistent archive role target user', async () => {
		await expect(setArchiveUserRole(db, 'missing-user', 'archive_reader', admin)).rejects.toMatchObject({
			status: 404
		});
	});

	it('refuses to remove the last archive_admin without mutating or auditing', async () => {
		await db.insert(schema.appUserRoles).values({ userId: 'admin', role: 'archive_admin' });
		await expect(setArchiveUserRole(db, 'admin', null, admin)).rejects.toMatchObject({
			status: 409,
			message: 'cannot remove the last archive_admin'
		});
		const [role] = await db.select().from(schema.appUserRoles).where(eq(schema.appUserRoles.userId, 'admin'));
		expect(role.role).toBe('archive_admin');
		expect(
			await db
				.select()
				.from(schema.sourceLifecycleEvents)
				.where(eq(schema.sourceLifecycleEvents.eventType, 'archive_role_changed'))
		).toHaveLength(0);
	});

	it('allows admin demotion when another archive_admin exists', async () => {
		await db.insert(schema.appUserRoles).values([
			{ userId: 'admin', role: 'archive_admin' },
			{ userId: 'reviewer', role: 'archive_admin' }
		]);
		await expect(setArchiveUserRole(db, 'admin', 'archive_reviewer', admin)).resolves.toEqual({
			userId: 'admin',
			role: 'archive_reviewer'
		});
		const rows = await db.select().from(schema.appUserRoles);
		expect(rows.find((row) => row.userId === 'admin')?.role).toBe('archive_reviewer');
		expect(rows.find((row) => row.userId === 'reviewer')?.role).toBe('archive_admin');
	});

	it('requires CSRF guards for app-session mutation principals', async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'reader', email: 'reader@example.test' }));
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		const headers = new Headers({
			origin: 'https://archive.aynu.org',
			'content-type': 'application/json'
		});
		await expect(
			archiveMutationPrincipal(new Request('https://db.aynu.org/api/archive/review', { method: 'POST', headers }), 'archive_reader', db)
		).rejects.toMatchObject({ status: 403 });

		headers.set('x-archive-csrf', await issueArchiveCsrfToken('reader'));
		await expect(
			archiveMutationPrincipal(new Request('https://db.aynu.org/api/archive/review', { method: 'POST', headers }), 'archive_reader', db)
		).resolves.toMatchObject({ userId: 'reader', authn: 'app_session' });
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
		expect(result.kind).toBe('session');
		if (result.kind !== 'session') throw new Error('expected upload session');
		expect(result.session.sourceFileId).toBe(result.sourceFile.id);
		expect((await db.select().from(schema.sourceFiles)).length).toBe(1);
		expect((await db.select().from(schema.uploadSessions)).length).toBe(1);
	});

	it('reconciles verified finalize results into a blob and pending revision once', async () => {
		await seedUploadSource();
		const created = await createUploadSession(db, contributor, {
			sourceSlug: 'source-one',
			role: 'scan',
			bytes: 42,
			sha256: 'b'.repeat(64),
			declaredMediaType: 'application/pdf'
		});
		expect(created.kind).toBe('session');
		if (created.kind !== 'session') throw new Error('expected upload session');
		const result = {
			sessionId: created.session.id,
			status: 'verified',
			sha256: 'b'.repeat(64),
			bytes: 42,
			detectedMediaType: 'application/pdf',
			blobKey: `blobs/sha256/bb/${'b'.repeat(64)}`,
			finalizedAt: '2026-01-01T00:00:00.000Z'
		};

		const upload = await reconcileUploadFinalization(db, created.session.id, contributor, { status: 200, body: result });
		expect(upload.state).toBe('verified');
		expect(await db.select().from(schema.archiveBlobs).where(eq(schema.archiveBlobs.sha256, result.sha256))).toHaveLength(1);
		const revisions = await db.select().from(schema.fileRevisions).where(eq(schema.fileRevisions.sourceFileId, created.sourceFile.id));
		expect(revisions).toHaveLength(1);
		expect(revisions[0]).toMatchObject({
			revisionNo: 1,
			blobSha256: result.sha256,
			originalFilename: 'bbbbbbbbbbbb.pdf',
			reviewStatus: 'pending',
			isCurrent: false
		});

		await reconcileUploadFinalization(db, created.session.id, contributor, { status: 200, body: result });
		expect(await db.select().from(schema.archiveBlobs).where(eq(schema.archiveBlobs.sha256, result.sha256))).toHaveLength(1);
		expect(await db.select().from(schema.fileRevisions).where(eq(schema.fileRevisions.sourceFileId, created.sourceFile.id))).toHaveLength(1);
	});

	it('reconciles quarantined finalize results into a failed upload session', async () => {
		await seedUploadSource();
		const created = await createUploadSession(db, contributor, {
			sourceSlug: 'source-one',
			role: 'scan',
			bytes: 42,
			sha256: 'c'.repeat(64),
			declaredMediaType: 'application/pdf'
		});
		expect(created.kind).toBe('session');
		if (created.kind !== 'session') throw new Error('expected upload session');
		const result = {
			sessionId: created.session.id,
			status: 'quarantined',
			reason: 'staging object digest or size mismatch',
			expectedSha256: 'c'.repeat(64),
			actualSha256: 'd'.repeat(64),
			expectedBytes: 42,
			actualBytes: 41,
			finalizedAt: '2026-01-01T00:00:00.000Z'
		};

		const upload = await reconcileUploadFinalization(db, created.session.id, contributor, { status: 200, body: result });
		expect(upload.state).toBe('failed');
		expect(upload.errorCode).toBe(result.reason);
		const [session] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, created.session.id));
		expect(session).toMatchObject({ state: 'failed', errorCode: result.reason });
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
		await expect(approveRevision(db, 'rev-1', reviewer)).rejects.toThrow('revision already decided');
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
		await db
			.update(schema.sources)
			.set({
				titleEn: 'Source One',
				titleAin: 'Sine kampi',
				author: 'Author One',
				yearText: '1901'
			})
			.where(eq(schema.sources.id, 'source-1'));
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
				source: {
					slug: 'source-one',
					title: '資料一',
					titleEn: 'Source One',
					titleAin: 'Sine kampi',
					author: 'Author One',
					yearText: '1901'
				},
				revisionId: 'rev-1',
				page: 2,
				variant: 'gemini'
			});
		} finally {
			await rm(ainuRoot, { recursive: true, force: true });
		}
	});

	it('includes source display metadata on each OCR hit', async () => {
		await seedRevision('approved');
		await db
			.update(schema.sources)
			.set({
				titleEn: 'Source One',
				titleAin: 'Sine kampi',
				author: 'Author One',
				yearStart: 1901,
				yearCertainty: 'exact'
			})
			.where(eq(schema.sources.id, 'source-1'));
		await db.insert(schema.sources).values({
			id: 'source-2',
			slug: 'source-two',
			title: '資料二',
			titleEn: 'Source Two',
			titleAin: 'Tu kampi',
			author: 'Author Two',
			yearStart: 1902,
			yearEnd: 1904,
			yearCertainty: 'range',
			category: 'primary',
			type: 'book',
			humanDownload: true
		});
		await db.insert(schema.sourceFiles).values({
			id: 'file-2',
			sourceId: 'source-2',
			role: 'scan',
			checkoutRepoId: 'repo-1',
			checkoutPath: 'books/source-two.pdf',
			createdBy: 'contributor'
		});
		await db.insert(schema.archiveBlobs).values({
			sha256: 'b'.repeat(64),
			bytes: 99,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date()
		});
		await db.insert(schema.fileRevisions).values({
			id: 'rev-2',
			sourceFileId: 'file-2',
			revisionNo: 1,
			blobSha256: 'b'.repeat(64),
			originalFilename: 'source-two.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(2_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(3_000)
		});
		await replaceOcrPages(db, 'rev-1', 'gemini', [{ page: 1, text: 'metadata needle one' }]);
		await replaceOcrPages(db, 'rev-2', 'gemini', [{ page: 1, text: 'metadata needle two' }]);

		const result = await searchOcr(db, reader, { q: 'metadata', limit: 10 });
		const sourcesByRevision = new Map(result.items.map((item) => [item.revisionId, item.source]));

		expect(sourcesByRevision.get('rev-1')).toMatchObject({
			slug: 'source-one',
			title: '資料一',
			titleEn: 'Source One',
			titleAin: 'Sine kampi',
			author: 'Author One',
			yearStart: 1901,
			yearEnd: null,
			yearCertainty: 'exact'
		});
		expect(sourcesByRevision.get('rev-2')).toMatchObject({
			slug: 'source-two',
			title: '資料二',
			titleEn: 'Source Two',
			titleAin: 'Tu kampi',
			author: 'Author Two',
			yearStart: 1902,
			yearEnd: 1904,
			yearCertainty: 'range'
		});
	});

	it('returns OCR snippet offsets against normalized text and total visible hits', async () => {
		await seedRevision('approved');
		await db.insert(schema.sourceFiles).values({
			id: 'file-2',
			sourceId: 'source-1',
			role: 'supplement',
			checkoutRepoId: 'repo-1',
			checkoutPath: 'books/supplement.pdf',
			createdBy: 'contributor'
		});
		await db.insert(schema.archiveBlobs).values({
			sha256: 'b'.repeat(64),
			bytes: 99,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date()
		});
		await db.insert(schema.fileRevisions).values({
			id: 'rev-2',
			sourceFileId: 'file-2',
			revisionNo: 1,
			blobSha256: 'b'.repeat(64),
			originalFilename: 'supplement.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(2_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(3_000)
		});
		await replaceOcrPages(db, 'rev-1', 'gemini', [{ page: 1, text: 'alpha   Kamuy\nbeta kamuy gamma' }]);
		await replaceOcrPages(db, 'rev-2', 'gemini', [{ page: 1, text: 'delta kamuy epsilon' }]);

		const result = await searchOcr(db, reader, { q: 'kamuy', limit: 1, maxChars: 80 });
		expect(result.total).toBe(2);
		expect(result.items).toHaveLength(1);
		expect(result.nextCursor).toBeTruthy();
		for (const offset of result.items[0].snippet.offsets) {
			expect(result.items[0].snippet.text.slice(offset.start, offset.end).toLocaleLowerCase()).toBe('kamuy');
		}
	});

	it('lists upload sessions by active defaults, explicit state, owner, and admin all scope', async () => {
		await seedUploadSource();
		const otherContributor: ArchivePrincipal = {
			...contributor,
			userId: 'other',
			identity: { kind: 'github_login', value: 'other' }
		};
		const created: schema.UploadSession[] = [];
		for (const [index, suffix] of ['1', '2', '3', '4'].entries()) {
			const principal = index === 3 ? otherContributor : contributor;
			const result = await createUploadSession(db, principal, {
				sourceSlug: 'source-one',
				role: 'scan',
				bytes: 10 + index,
				sha256: suffix.repeat(64),
				declaredMediaType: 'application/pdf'
			});
			if (result.kind !== 'session') throw new Error('expected upload session');
			created.push(result.session);
		}
		await db.update(schema.uploadSessions).set({ state: 'failed' }).where(eq(schema.uploadSessions.id, created[1].id));
		await db.update(schema.uploadSessions).set({ state: 'verified' }).where(eq(schema.uploadSessions.id, created[2].id));

		expect((await listUploadSessions(db, contributor)).uploads.map((row) => row.id)).toEqual([created[0].id]);
		expect((await listUploadSessions(db, contributor, { states: ['failed'] })).uploads.map((row) => row.id)).toEqual([
			created[1].id
		]);
		expect((await listUploadSessions(db, contributor, { all: true })).uploads.map((row) => row.submittedBy)).toEqual([
			'contributor'
		]);
		expect((await listUploadSessions(db, admin, { all: true })).uploads.map((row) => row.id).sort()).toEqual(
			[created[0].id, created[3].id].sort()
		);
		await expect(listUploadSessions(db, contributor, { states: ['bogus'] })).rejects.toMatchObject({ status: 400 });
	});

	it('carries decided revision details on approve and reject conflicts', async () => {
		await seedRevision('pending');
		const approved = await approveRevision(db, 'rev-1', reviewer);
		const expected = {
			review_status: 'approved',
			reviewed_by: 'reviewer',
			reviewed_at: approved.reviewedAt?.toISOString(),
			review_note: null
		};
		await expect(approveRevision(db, 'rev-1', reviewer)).rejects.toMatchObject({
			status: 409,
			details: expected
		});
		let thrown: unknown;
		try {
			await rejectRevision(db, 'rev-1', reviewer, 'second decision');
		} catch (e) {
			try {
				throwArchiveError(e);
			} catch (routeError) {
				thrown = routeError;
			}
		}
		expect(thrown).toMatchObject({
			status: 409,
			body: { message: 'revision already decided', ...expected }
		});
	});

	it('returns usage summary counts and denies MCP assertion callers at the route', async () => {
		env.ARCHIVE_DAILY_BYTE_LIMIT = '1000';
		env.ARCHIVE_CONCURRENT_STREAM_LIMIT = '5';
		await seedRevision('approved');
		const now = new Date();
		const day = now.toISOString().slice(0, 10);
		const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
		await db.insert(schema.archiveStreamDailyUsage).values({
			userId: 'reader',
			day,
			bytesReserved: 321,
			updatedAt: now
		});
		await db.insert(schema.archiveStreamLeases).values([
			{
				id: 'lease-active',
				userId: 'reader',
				revisionId: 'rev-1',
				expiresAt: new Date(now.getTime() + 60_000),
				createdAt: now
			},
			{
				id: 'lease-expired',
				userId: 'reader',
				revisionId: 'rev-1',
				expiresAt: new Date(now.getTime() - 60_000),
				createdAt: now
			}
		]);

		await expect(getUsageSummary(db, reader)).resolves.toEqual({
			date: day,
			bytesUsed: 321,
			dailyByteLimit: 1000,
			resetAt,
			activeStreams: 1,
			concurrentStreamLimit: 5
		});

		env.ASSERTION_KEY_MCP = 'mcp-secret';
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/me/usage/+server')>(
			'../../../routes/api/archive/me/usage/+server'
		);
		const headers = await buildMcpAssertionHeaders(env.ASSERTION_KEY_MCP, 'octocat', Math.floor(Date.now() / 1000), 'usage-denial');
		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/me/usage', { headers }),
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });
	});

	it('returns the same pending-review total on subsequent pages', async () => {
		await seedRevision('pending');
		for (let index = 2; index <= 4; index += 1) {
			const hash = String(index).repeat(64);
			await db.insert(schema.sourceFiles).values({
				id: `file-${index}`,
				sourceId: 'source-1',
				role: index === 2 ? 'epub' : index === 3 ? 'supplement' : 'derivative',
				checkoutRepoId: 'repo-1',
				checkoutPath: `books/${index}.pdf`,
				createdBy: 'contributor'
			});
			await db.insert(schema.archiveBlobs).values({
				sha256: hash,
				bytes: index,
				detectedMediaType: 'application/pdf',
				storageState: 'verified',
				verifiedAt: new Date()
			});
			await db.insert(schema.fileRevisions).values({
				id: `rev-${index}`,
				sourceFileId: `file-${index}`,
				revisionNo: 1,
				blobSha256: hash,
				originalFilename: `${index}.pdf`,
				declaredMediaType: 'application/pdf',
				artifactKind: 'original',
				reviewStatus: 'pending',
				isCurrent: false,
				submittedBy: 'contributor',
				submittedAt: new Date(1_000 + index)
			});
		}

		const first = await listPendingReview(db, null, 2);
		expect(first.total).toBe(4);
		expect(first.nextCursor).toBeTruthy();
		const second = await listPendingReview(db, first.nextCursor, 2);
		expect(second.total).toBe(4);
		expect(second.items).toHaveLength(2);
	});

	it('returns full review card context only when include full is requested', async () => {
		await seedRevision('approved');
		await db.update(schema.fileRevisions).set({ id: 'rev-current' }).where(eq(schema.fileRevisions.id, 'rev-1'));
		await db.insert(schema.archiveBlobs).values([
			{
				sha256: 'b'.repeat(64),
				bytes: 200,
				detectedMediaType: 'application/pdf',
				storageState: 'verified',
				verifiedAt: new Date()
			},
			{
				sha256: 'c'.repeat(64),
				bytes: 300,
				detectedMediaType: 'application/pdf',
				storageState: 'verified',
				verifiedAt: new Date()
			}
		]);
		await db.insert(schema.fileRevisions).values([
			{
				id: 'rev-rejected',
				sourceFileId: 'file-1',
				revisionNo: 2,
				blobSha256: 'b'.repeat(64),
				originalFilename: 'old.pdf',
				declaredMediaType: 'application/pdf',
				artifactKind: 'original',
				reviewStatus: 'rejected',
				isCurrent: false,
				submittedBy: 'contributor',
				submittedAt: new Date(2_000),
				reviewedBy: 'reviewer',
				reviewedAt: new Date(3_000),
				reviewNote: 'bad scan'
			},
			{
				id: 'rev-pending',
				sourceFileId: 'file-1',
				revisionNo: 3,
				blobSha256: 'c'.repeat(64),
				originalFilename: 'new.pdf',
				declaredMediaType: 'application/pdf',
				artifactKind: 'original',
				reviewStatus: 'pending',
				isCurrent: false,
				submittedBy: 'contributor',
				submittedAt: new Date(4_000)
			}
		]);
		await db.insert(schema.sourceFiles).values({
			id: 'file-2',
			sourceId: 'source-1',
			role: 'supplement',
			checkoutRepoId: 'repo-1',
			checkoutPath: 'books/duplicate.pdf'
		});
		await db.insert(schema.fileRevisions).values({
			id: 'rev-duplicate',
			sourceFileId: 'file-2',
			revisionNo: 1,
			blobSha256: 'c'.repeat(64),
			originalFilename: 'duplicate.pdf',
			declaredMediaType: 'application/pdf',
			artifactKind: 'original',
			reviewStatus: 'approved',
			isCurrent: true,
			submittedBy: 'contributor',
			submittedAt: new Date(5_000),
			reviewedBy: 'reviewer',
			reviewedAt: new Date(6_000)
		});

		const light = await listPendingReview(db, null, 10);
		expect(light.items[0]).toMatchObject({ revisionId: 'rev-pending', exactDuplicates: [] });
		expect(light.items[0]).not.toHaveProperty('currentRevisionSummary');
		const full = await listPendingReview(db, null, 10, { include: 'full' });
		expect(full.items[0]).toMatchObject({
			revisionId: 'rev-pending',
			currentRevision: 'rev-current',
			currentRevisionSummary: {
				id: 'rev-current',
				revisionNo: 1,
				bytes: 1234,
				sha256: sha
			},
			exactDuplicates: [
				{
					revisionId: 'rev-duplicate',
					sourceFileId: 'file-2',
					sourceSlug: 'source-one',
					reviewStatus: 'approved'
				}
			]
		});
		const fullItem = full.items[0] as (typeof full.items)[number] & { priorRevisions: { id: string }[] };
		expect(fullItem.priorRevisions.map((row) => row.id)).toEqual(['rev-rejected', 'rev-current']);
	});

	it('deduplicates verified upload creates and lets quarantined hashes create sessions', async () => {
		await seedUploadSource();
		await db.insert(schema.archiveRepositories).values({ id: 'repo-1', name: 'books' });
		await db.insert(schema.archiveBlobs).values([
			{
				sha256: 'd'.repeat(64),
				bytes: 42,
				detectedMediaType: 'application/pdf',
				storageState: 'verified',
				verifiedAt: new Date(),
				createdBy: 'contributor'
			},
			{
				sha256: 'e'.repeat(64),
				bytes: 42,
				detectedMediaType: 'application/pdf',
				storageState: 'quarantined',
				createdBy: 'contributor'
			}
		]);

		const deduplicated = await createUploadSession(db, contributor, {
			sourceSlug: 'source-one',
			role: 'scan',
			checkoutRepo: 'books',
			checkoutPath: 'books/existing.pdf',
			bytes: 42,
			sha256: 'd'.repeat(64),
			declaredMediaType: 'application/pdf'
		});
		expect(deduplicated.kind).toBe('deduplicated');
		if (deduplicated.kind !== 'deduplicated') throw new Error('expected deduplicated revision');
		expect(deduplicated.revision).toMatchObject({
			blobSha256: 'd'.repeat(64),
			reviewStatus: 'pending',
			originalFilename: 'existing.pdf'
		});
		expect(await db.select().from(schema.uploadSessions)).toHaveLength(0);

		const retry = await createUploadSession(db, contributor, {
			sourceSlug: 'source-one',
			role: 'scan',
			bytes: 42,
			sha256: 'e'.repeat(64),
			declaredMediaType: 'application/pdf'
		});
		expect(retry.kind).toBe('session');
		expect(await db.select().from(schema.uploadSessions)).toHaveLength(1);
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

describe('archive API route handlers', () => {
	it('sends the worker multipart create contract exactly', async () => {
		env.ASSERTION_KEY_SOURCES = 'assertion-secret';
		await seedUploadSource();
		const { mutation } = await seedServicePrincipal('contributor', 'archive_contributor', 'svc-create');
		let captured: Request | null = null;
		const fetcher = {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				captured = input instanceof Request ? input : new Request(input, init);
				return Response.json({ stagingKey: 'staging/worker-owned', uploadId: 'mpu-1' });
			}
		};
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/uploads/+server')>(
			'../../../routes/api/archive/uploads/+server'
		);
		const request = new Request('https://db.aynu.org/api/archive/uploads', {
			method: 'POST',
			headers: mutation,
			body: JSON.stringify({
				source_slug: 'source-one',
				role: 'scan',
				size: 42,
				sha256: 'e'.repeat(64),
				declared_media_type: 'application/pdf'
			})
		});

		const response = await POST({ request, platform: { env: { ARCHIVE: fetcher } }, locals: { archiveDb: db } } as never);
		expect(response.status).toBe(201);
		const payload = (await response.json()) as {
			upload: { id: string };
			dataplane: { stagingKey: string; uploadId: string };
		};
		expect(payload.dataplane).toEqual({ stagingKey: 'staging/worker-owned', uploadId: 'mpu-1' });
		expect(captured).toBeInstanceOf(Request);
		expect(await captured!.clone().json()).toEqual({
			sessionId: payload.upload.id,
			expectedSha256: 'e'.repeat(64),
			expectedBytes: 42,
			declaredMediaType: 'application/pdf'
		});
		const [session] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.id, payload.upload.id));
		expect(session).toMatchObject({
			state: 'uploading',
			stagingKey: 'staging/worker-owned',
			multipartId: 'mpu-1'
		});
	});

	it('short-circuits upload create for an already verified blob', async () => {
		env.ASSERTION_KEY_SOURCES = 'assertion-secret';
		await seedUploadSource();
		await db.insert(schema.archiveBlobs).values({
			sha256: '9'.repeat(64),
			bytes: 42,
			detectedMediaType: 'application/pdf',
			storageState: 'verified',
			verifiedAt: new Date(),
			createdBy: 'contributor'
		});
		const { mutation } = await seedServicePrincipal('contributor', 'archive_contributor', 'svc-dedup');
		const fetcher = {
			async fetch() {
				throw new Error('dataplane should not be called');
			}
		};
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/uploads/+server')>(
			'../../../routes/api/archive/uploads/+server'
		);
		const response = await POST({
			request: new Request('https://db.aynu.org/api/archive/uploads', {
				method: 'POST',
				headers: mutation,
				body: JSON.stringify({
					source_slug: 'source-one',
					role: 'scan',
					size: 42,
					sha256: '9'.repeat(64),
					declared_media_type: 'application/pdf'
				})
			}),
			platform: { env: { ARCHIVE: fetcher } },
			locals: { archiveDb: db }
		} as never);

		expect(response.status).toBe(200);
		const payload = (await response.json()) as { deduplicated: boolean; revisionId: string; fileId: string };
		expect(payload).toMatchObject({ deduplicated: true, fileId: expect.any(String), revisionId: expect.any(String) });
		expect(await db.select().from(schema.uploadSessions)).toHaveLength(0);
		const [revision] = await db.select().from(schema.fileRevisions).where(eq(schema.fileRevisions.id, payload.revisionId));
		expect(revision).toMatchObject({ blobSha256: '9'.repeat(64), reviewStatus: 'pending' });
	});

	it('marks the session failed when dataplane multipart create fails', async () => {
		env.ASSERTION_KEY_SOURCES = 'assertion-secret';
		await seedUploadSource();
		const { mutation } = await seedServicePrincipal('contributor', 'archive_contributor', 'svc-create-fail');
		const fetcher = {
			async fetch() {
				return Response.json({ error: 'bad create contract' }, { status: 400 });
			}
		};
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/uploads/+server')>(
			'../../../routes/api/archive/uploads/+server'
		);
		const request = new Request('https://db.aynu.org/api/archive/uploads', {
			method: 'POST',
			headers: mutation,
			body: JSON.stringify({
				source_slug: 'source-one',
				role: 'scan',
				size: 42,
				sha256: 'f'.repeat(64),
				declared_media_type: 'application/pdf'
			})
		});

		await expect(
			POST({ request, platform: { env: { ARCHIVE: fetcher } }, locals: { archiveDb: db } } as never)
		).rejects.toMatchObject({
			status: 500,
			body: { message: 'bad create contract' }
		});
		const [session] = await db.select().from(schema.uploadSessions).where(eq(schema.uploadSessions.expectedSha256, 'f'.repeat(64)));
		expect(session).toMatchObject({ state: 'failed', errorCode: 'bad create contract' });
	});

	it('issues CSRF tokens for session principals and rejects MCP assertion callers', async () => {
		const { auth } = await seedServicePrincipal('reader', 'archive_reader', 'svc-reader');
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/csrf/+server')>(
			'../../../routes/api/archive/csrf/+server'
		);
		const response = await GET({
			request: new Request('https://db.aynu.org/api/archive/csrf', { headers: auth }),
			locals: { archiveDb: db }
		} as never);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { token: string; expires_at: string };
		expect(typeof body.token).toBe('string');
		expect(body.expires_at).toMatch(/Z$/u);
		await expect(verifyArchiveCsrfToken(body.token, 'reader')).resolves.toBeUndefined();
		await expect(verifyArchiveCsrfToken(body.token, 'contributor')).rejects.toThrow(ArchiveHttpError);
		await expect(
			requireArchiveMutationGuards(
				new Request('https://db.aynu.org/api/archive/uploads', {
					method: 'POST',
					headers: {
						Origin: 'https://archive.aynu.org',
						'Content-Type': 'application/json',
						'X-Archive-CSRF': body.token
					}
				}),
				'reader'
			)
		).resolves.toBeUndefined();

		env.ASSERTION_KEY_MCP = 'mcp-secret';
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		const mcpHeaders = await buildMcpAssertionHeaders(env.ASSERTION_KEY_MCP, 'octocat', Math.floor(Date.now() / 1000), 'csrf-denial');
		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/csrf', { headers: mcpHeaders }),
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });
	});

	it('enforces archive_admin on admin user GET and POST routes', async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'reader', email: 'reader@example.test' }));
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/admin/users/+server')>(
			'../../../routes/api/archive/admin/users/+server'
		);
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/admin/users/[userId]/role/+server')>(
			'../../../routes/api/archive/admin/users/[userId]/role/+server'
		);

		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/admin/users'),
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });

		await expect(
			POST({
				request: new Request('https://db.aynu.org/api/archive/admin/users/other/role', {
					method: 'POST',
					headers: {
						origin: 'https://archive.aynu.org',
						'content-type': 'application/json',
						'x-archive-csrf': await issueArchiveCsrfToken('reader')
					},
					body: JSON.stringify({ role: 'archive_reader' })
				}),
				params: { userId: 'other' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });
	});

	it('enforces CSRF on admin user role POST route', async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'admin', email: 'admin@example.test' }));
		await db.insert(schema.appUserRoles).values({ userId: 'admin', role: 'archive_admin' });
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/admin/users/[userId]/role/+server')>(
			'../../../routes/api/archive/admin/users/[userId]/role/+server'
		);
		const base = {
			method: 'POST',
			headers: {
				origin: 'https://archive.aynu.org',
				'content-type': 'application/json'
			},
			body: JSON.stringify({ role: 'archive_reader' })
		};

		await expect(
			POST({
				request: new Request('https://db.aynu.org/api/archive/admin/users/reader/role', base),
				params: { userId: 'reader' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });

		await expect(
			POST({
				request: new Request('https://db.aynu.org/api/archive/admin/users/reader/role', {
					...base,
					headers: {
						...base.headers,
						'x-archive-csrf': 'bad-token'
					}
				}),
				params: { userId: 'reader' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });
	});

	it('rejects service-token and MCP assertion principals on admin user role POST route', async () => {
		const { POST } = await importRoute<typeof import('../../../routes/api/archive/admin/users/[userId]/role/+server')>(
			'../../../routes/api/archive/admin/users/[userId]/role/+server'
		);
		const { mutation } = await seedServicePrincipal('admin', 'archive_admin', 'svc-admin-role');

		await expect(
			POST({
				request: new Request('https://db.aynu.org/api/archive/admin/users/reader/role', {
					method: 'POST',
					headers: mutation,
					body: JSON.stringify({ role: 'archive_reader' })
				}),
				params: { userId: 'reader' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({
			status: 403,
			body: { message: 'role changes require an app-session principal' }
		});

		env.ASSERTION_KEY_MCP = 'mcp-secret';
		await db.insert(schema.userIdentities).values({ userId: 'reader', kind: 'github_login', value: 'octocat' });
		const mcpHeaders = await buildMcpAssertionHeaders(env.ASSERTION_KEY_MCP, 'octocat', Math.floor(Date.now() / 1000), 'role-mcp-denial');
		await expect(
			POST({
				request: new Request('https://db.aynu.org/api/archive/admin/users/reader/role', {
					method: 'POST',
					headers: mcpHeaders,
					body: JSON.stringify({ role: 'archive_reader' })
				}),
				params: { userId: 'reader' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });
	});

	it('lists archive repositories ordered by name', async () => {
		const { auth } = await seedServicePrincipal('reader', 'archive_reader', 'svc-repos');
		await db.insert(schema.archiveRepositories).values([
			{ id: 'repo-z', name: 'zeta', active: true },
			{ id: 'repo-a', name: 'alpha', active: false },
			{ id: 'repo-m', name: 'middle', active: true }
		]);
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/repositories/+server')>(
			'../../../routes/api/archive/repositories/+server'
		);
		const response = await GET({
			request: new Request('https://db.aynu.org/api/archive/repositories', { headers: auth }),
			locals: { archiveDb: db }
		} as never);
		expect(await response.json()).toEqual({
			repositories: [
				{ id: 'repo-a', name: 'alpha', active: false },
				{ id: 'repo-m', name: 'middle', active: true },
				{ id: 'repo-z', name: 'zeta', active: true }
			]
		});
	});

	it('enforces reader access and derivative width validation on page derivative routes', async () => {
		await seedRevision('approved');
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'other', email: 'other@example.test' }));
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/revisions/[id]/pages/[page].webp/+server')>(
			'../../../routes/api/archive/revisions/[id]/pages/[page].webp/+server'
		);

		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/revisions/rev-1/pages/1.webp'),
				params: { id: 'rev-1', page: '1' },
				locals: { archiveDb: db }
			} as never)
		).rejects.toMatchObject({ status: 403 });

		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({ id: 'reader', email: 'reader@example.test' }));
		await db.insert(schema.appUserRoles).values({ userId: 'reader', role: 'archive_reader' });
		await expect(
			GET({
				request: new Request('https://db.aynu.org/api/archive/revisions/rev-1/pages/1.webp?w=999'),
				params: { id: 'rev-1', page: '1' },
				locals: { archiveDb: db },
				platform: { env: { ARCHIVE: { async fetch() { return new Response(null); } } } }
			} as never)
		).rejects.toMatchObject({ status: 400 });
	});

	it('maps non-OK page derivative upstream responses to 404', async () => {
		env.ASSERTION_KEY_SOURCES = 'assertion-secret';
		await seedRevision('approved');
		const { auth } = await seedServicePrincipal('reader', 'archive_reader', 'svc-page');
		let captured: Request | null = null;
		const fetcher = {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				captured = input instanceof Request ? input : new Request(input, init);
				return Response.json({ error: 'missing derivative' }, { status: 500 });
			}
		};
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/revisions/[id]/pages/[page].webp/+server')>(
			'../../../routes/api/archive/revisions/[id]/pages/[page].webp/+server'
		);

		const response = await GET({
			request: new Request('https://db.aynu.org/api/archive/revisions/rev-1/pages/1.webp?w=300', { headers: auth }),
			params: { id: 'rev-1', page: '1' },
			locals: { archiveDb: db },
			platform: { env: { ARCHIVE: fetcher } }
		} as never);

		expect(response.status).toBe(404);
		expect(captured).toBeInstanceOf(Request);
		expect(new URL(captured!.url).pathname).toBe('/internal/derivatives/rev-1/pages/1');
		expect(new URL(captured!.url).searchParams.get('w')).toBe('300');
		expect(captured!.headers.get('x-archive-assertion')).toBeTruthy();
		expect(captured!.headers.get('x-archive-signature')).toBeTruthy();
	});

	it('proxies linearized derivative range responses and mirrors dataplane headers', async () => {
		env.ASSERTION_KEY_SOURCES = 'assertion-secret';
		await seedRevision('approved');
		const { auth } = await seedServicePrincipal('reader', 'archive_reader', 'svc-linearized');
		let captured: Request | null = null;
		const fetcher = {
			async fetch(input: RequestInfo | URL, init?: RequestInit) {
				captured = input instanceof Request ? input : new Request(input, init);
				return new Response('pdf-bytes', {
					status: 206,
					headers: {
						'content-type': 'application/pdf',
						'content-range': 'bytes 0-8/100',
						'content-length': '9',
						'accept-ranges': 'bytes',
						'etag': '"linearized"',
						'cache-control': 'public, max-age=31536000, immutable'
					}
				});
			}
		};
		const { GET } = await importRoute<typeof import('../../../routes/api/archive/revisions/[id]/linearized/+server')>(
			'../../../routes/api/archive/revisions/[id]/linearized/+server'
		);

		const response = await GET({
			request: new Request('https://db.aynu.org/api/archive/revisions/rev-1/linearized', {
				headers: new Headers([...auth.entries(), ['range', 'bytes=0-8']])
			}),
			params: { id: 'rev-1' },
			locals: { archiveDb: db },
			platform: { env: { ARCHIVE: fetcher } }
		} as never);

		expect(response.status).toBe(206);
		expect(await response.text()).toBe('pdf-bytes');
		expect(response.headers.get('content-type')).toBe('application/pdf');
		expect(response.headers.get('content-range')).toBe('bytes 0-8/100');
		expect(response.headers.get('content-length')).toBe('9');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('etag')).toBe('"linearized"');
		expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
		expect(captured).toBeInstanceOf(Request);
		expect(new URL(captured!.url).pathname).toBe('/internal/derivatives/rev-1/linearized');
		expect(captured!.headers.get('range')).toBe('bytes=0-8');
	});
});
