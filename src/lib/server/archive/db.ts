import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, lt, max, notExists, or, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { env } from '$env/dynamic/private';
import {
	appUserRoles,
	archiveBlobs,
	archiveContentApiDailyUsage,
	archiveRepositories,
	archiveStreamDailyUsage,
	archiveStreamLeases,
	capabilityTokens,
	fileRevisions,
	githubLoginCache,
	revisionOcrCoverage,
	sourceFiles,
	sourceLifecycleEvents,
	sources,
	uploadSessions,
	user,
	userIdentities
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { recordArchiveEvent } from './audit';
import { ArchiveHttpError } from './errors';
import { DEPLOYED_SEARCH_MODES } from './search-modes';
import { decodeCursor, encodeCursor, type FileCursor } from './cursor';
import { base64url, fromBase64url } from './crypto';
import { archiveRoleAtLeast, isArchiveRole, iso, type ArchivePrincipal, type ArchiveRole } from './types';

type Db = LibSQLDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_BYTES = 5 * 1024 * 1024 * 1024;
// Reading page images, linearized views, and OCR text gets a larger daily budget than whole-file downloads.
const DEFAULT_DAILY_VIEW_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_CONCURRENT_STREAMS = 3;
const DEFAULT_TEXT_CALL_LIMIT = 1000;
const DEFAULT_TEXT_PAGE_LIMIT = 10_000;
const DEFAULT_SEARCH_CALL_LIMIT = 500;
const DEFAULT_SEARCH_HIT_LIMIT = 10_000;
const SOURCE_FILE_ROLES = ['scan', 'epub', 'supplement', 'derivative'] as const;
const UPLOAD_SESSION_STATES = ['initiated', 'uploading', 'uploaded', 'finalizing', 'verified', 'failed', 'aborted', 'expired'] as const;
type SourceFileRole = (typeof SOURCE_FILE_ROLES)[number];
type UploadSessionState = (typeof UPLOAD_SESSION_STATES)[number];
export type ArchiveBudgetKind = 'download' | 'view';
export type CapabilityRedemptionRequest =
	| { kind: 'full' }
	| { kind: 'range_header'; rangeHeader: string | null };
export type ArchiveFileSort = 'updated' | 'title' | 'year-desc' | 'year-asc' | 'significance';
export type ArchiveUserKind = 'person' | 'system' | 'machine';

export type ArchiveAdminUser = {
	userId: string;
	name: string;
	email: string;
	role: ArchiveRole | null;
	roleUpdatedAt: string | null;
	login: string | null;
	serviceToken: string | null;
	kind: ArchiveUserKind;
};

export const SYSTEM_USER_IDS = ['migration'] as const;

type FinalizeSuccessResult = {
	sessionId: string;
	status: 'verified';
	sha256: string;
	bytes: number;
	detectedMediaType: string;
	blobKey: string;
	finalizedAt: string;
};

type FinalizeMismatchResult = {
	sessionId: string;
	status: 'quarantined';
	reason: string;
	expectedSha256: string;
	actualSha256: string;
	expectedBytes: number;
	actualBytes: number;
	finalizedAt: string;
};

function uuid(): string {
	return crypto.randomUUID();
}

function intEnv(name: string, fallback: number): number {
	const value = Number(env[name]);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function updatedCursor(date: Date, id: string): FileCursor {
	return { updatedAt: date.toISOString(), id };
}

function parseSourceFileRole(role: string | null | undefined): SourceFileRole | null {
	if (role == null || role === '') return null;
	if ((SOURCE_FILE_ROLES as readonly string[]).includes(role)) return role as SourceFileRole;
	throw new ArchiveHttpError(400, 'invalid source file role');
}

function emailDomain(email: string): string | null {
	const at = email.lastIndexOf('@');
	if (at < 0) return null;
	return email.slice(at + 1).trim().toLowerCase();
}

export function classifyArchiveUserKind(row: {
	userId: string;
	email: string;
	serviceToken?: string | null;
}): ArchiveUserKind {
	const domain = emailDomain(row.email);
	if ((SYSTEM_USER_IDS as readonly string[]).includes(row.userId) || domain?.endsWith('.invalid')) return 'system';
	if (row.serviceToken) return 'machine';
	return 'person';
}

export function requireReviewReadable(principal: ArchivePrincipal, reviewStatus: string, submittedBy: string): void {
	if (reviewStatus === 'approved') return;
	if (archiveRoleAtLeast(principal.role, 'archive_reviewer')) return;
	if (principal.role === 'archive_contributor' && submittedBy === principal.userId && reviewStatus === 'pending') return;
	throw new ArchiveHttpError(404, 'revision not found');
}

export function requireAccessState(principal: ArchivePrincipal, accessState: string): void {
	if (accessState === 'available') return;
	if (accessState === 'embargoed' && archiveRoleAtLeast(principal.role, 'archive_reviewer')) return;
	if (accessState === 'takedown' && principal.role === 'archive_admin') return;
	throw new ArchiveHttpError(403, 'revision is not readable');
}

function serializeUploadSession(row: schema.UploadSession) {
	return {
		...row,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
		expiresAt: iso(row.expiresAt)
	};
}

function isFinalizeSuccessResult(value: unknown): value is FinalizeSuccessResult {
	const row = value as Partial<FinalizeSuccessResult> | null;
	return (
		!!row &&
		row.status === 'verified' &&
		typeof row.sessionId === 'string' &&
		typeof row.sha256 === 'string' &&
		typeof row.bytes === 'number' &&
		typeof row.detectedMediaType === 'string'
	);
}

function isFinalizeMismatchResult(value: unknown): value is FinalizeMismatchResult {
	const row = value as Partial<FinalizeMismatchResult> | null;
	return (
		!!row &&
		row.status === 'quarantined' &&
		typeof row.sessionId === 'string' &&
		typeof row.reason === 'string' &&
		typeof row.expectedSha256 === 'string' &&
		typeof row.actualSha256 === 'string' &&
		typeof row.expectedBytes === 'number' &&
		typeof row.actualBytes === 'number'
	);
}

function originalFilenameFor(
	sourceFile: Pick<schema.SourceFile, 'label' | 'checkoutPath'>,
	sha256: string,
	declaredMediaType: string,
	checkoutPath?: string | null
): string {
	if (sourceFile.label?.trim()) return sourceFile.label.trim();
	const path = checkoutPath?.trim() || sourceFile.checkoutPath?.trim();
	if (path) {
		const name = path.split(/[\\/]/u).filter(Boolean).at(-1);
		if (name) return name;
	}
	const extension = mediaTypeExtension(declaredMediaType);
	return `${sha256.slice(0, 12)}${extension ? `.${extension}` : ''}`;
}

function mediaTypeExtension(mediaType: string): string | null {
	if (mediaType === 'application/pdf') return 'pdf';
	if (mediaType === 'application/epub+zip') return 'epub';
	return null;
}

async function nextRevisionNo(tx: Tx, sourceFileId: string): Promise<number> {
	const [{ revisionNo }] = await tx
		.select({ revisionNo: max(fileRevisions.revisionNo) })
		.from(fileRevisions)
		.where(eq(fileRevisions.sourceFileId, sourceFileId));
	return Number(revisionNo ?? 0) + 1;
}

async function resolveUploadSourceFile(
	tx: Tx,
	principal: ArchivePrincipal,
	input: { sourceSlug: string; role: string; checkoutRepo?: string | null; checkoutPath?: string | null }
): Promise<schema.SourceFile> {
	const [source] = await tx.select().from(sources).where(eq(sources.slug, input.sourceSlug)).limit(1);
	if (!source) throw new ArchiveHttpError(404, 'source not found');
	if (!source.humanDownload) throw new ArchiveHttpError(403, 'source rights do not allow archive uploads');
	let repoId: string | null = null;
	if (input.checkoutRepo) {
		const [repo] = await tx
			.select()
			.from(archiveRepositories)
			.where(eq(archiveRepositories.name, input.checkoutRepo))
			.limit(1);
		if (!repo) throw new ArchiveHttpError(400, 'checkout repository not found');
		repoId = repo.id;
	}
	let [slot] = await tx
		.select()
		.from(sourceFiles)
		.where(and(eq(sourceFiles.sourceId, source.id), eq(sourceFiles.role, input.role)))
		.limit(1);
	if (!slot) {
		[slot] = await tx
			.insert(sourceFiles)
			.values({
				id: uuid(),
				sourceId: source.id,
				role: input.role,
				checkoutRepoId: repoId,
				checkoutPath: input.checkoutPath ?? null,
				createdBy: principal.userId
			})
			.returning();
	}
	return slot;
}

function alreadyDecidedDetails(row: {
	reviewStatus: string;
	reviewedBy: string | null;
	reviewedAt: Date | null;
	reviewNote: string | null;
}): Record<string, unknown> {
	return {
		review_status: row.reviewStatus,
		reviewed_by: row.reviewedBy,
		reviewed_at: iso(row.reviewedAt),
		review_note: row.reviewNote
	};
}

export async function listSourceFiles(
	db: Db,
	slug: string,
	principal: ArchivePrincipal,
	options: { role?: string | null; includeHistory?: boolean } = {}
) {
	const role = parseSourceFileRole(options.role);
	const revisionClause = options.includeHistory
		? archiveRoleAtLeast(principal.role, 'archive_reviewer')
			? or(eq(fileRevisions.reviewStatus, 'approved'), eq(fileRevisions.reviewStatus, 'pending'))
			: eq(fileRevisions.reviewStatus, 'approved')
		: archiveRoleAtLeast(principal.role, 'archive_reviewer')
			? or(eq(fileRevisions.isCurrent, true), eq(fileRevisions.reviewStatus, 'pending'))
			: eq(fileRevisions.isCurrent, true);
	const clauses = [eq(sources.slug, slug)];
	if (role) clauses.push(eq(sourceFiles.role, role));
	const rows = await db
		.select({
			fileId: sourceFiles.id,
			role: sourceFiles.role,
			label: sourceFiles.label,
			checkoutPath: sourceFiles.checkoutPath,
			sortOrder: sourceFiles.sortOrder,
			revisionId: fileRevisions.id,
			revisionNo: fileRevisions.revisionNo,
			reviewStatus: fileRevisions.reviewStatus,
			isCurrent: fileRevisions.isCurrent,
			sha256: fileRevisions.blobSha256,
			bytes: archiveBlobs.bytes,
			mediaType: archiveBlobs.detectedMediaType,
			submittedAt: fileRevisions.submittedAt
		})
		.from(sourceFiles)
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.leftJoin(
			fileRevisions,
			and(eq(fileRevisions.sourceFileId, sourceFiles.id), revisionClause)
		)
		.leftJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(and(...clauses))
		.orderBy(asc(sourceFiles.sortOrder), asc(sourceFiles.id), desc(fileRevisions.submittedAt));
	return rows;
}

export async function listFiles(
	db: Db,
	cursorRaw: string | null,
	updatedSinceRaw: string | null,
	limit = 50,
	options: { role?: string | null; includeHistory?: boolean } = {}
) {
	const cursor = decodeCursor(cursorRaw);
	const updatedSince = updatedSinceRaw ? new Date(updatedSinceRaw) : null;
	if (updatedSinceRaw && Number.isNaN(updatedSince?.getTime())) throw new ArchiveHttpError(400, 'invalid updated_since');
	const role = parseSourceFileRole(options.role);
	const clauses = [eq(fileRevisions.reviewStatus, 'approved')];
	if (!options.includeHistory) clauses.push(eq(fileRevisions.isCurrent, true));
	if (role) clauses.push(eq(sourceFiles.role, role));
	if (updatedSince) clauses.push(gte(fileRevisions.reviewedAt, updatedSince));
	if (cursor) {
		const d = new Date(cursor.updatedAt);
		clauses.push(or(gt(fileRevisions.reviewedAt, d), and(eq(fileRevisions.reviewedAt, d), gt(sourceFiles.id, cursor.id)))!);
	}
	const rows = await db
		.select({
			fileId: sourceFiles.id,
			sourceSlug: sources.slug,
			role: sourceFiles.role,
			checkoutPath: sourceFiles.checkoutPath,
			sortOrder: sourceFiles.sortOrder,
			revisionId: fileRevisions.id,
			reviewedAt: fileRevisions.reviewedAt,
			sha256: fileRevisions.blobSha256,
			bytes: archiveBlobs.bytes,
			mediaType: archiveBlobs.detectedMediaType
		})
		.from(sourceFiles)
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.innerJoin(fileRevisions, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(and(...clauses))
		.orderBy(asc(fileRevisions.reviewedAt), asc(sourceFiles.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((r) => ({ ...r, reviewedAt: iso(r.reviewedAt) })),
		nextCursor:
			rows.length > limit && last?.reviewedAt
				? encodeCursor(updatedCursor(last.reviewedAt, last.fileId))
				: null
	};
}

export async function listArchiveRepositories(db: Db) {
	const rows = await db
		.select({
			id: archiveRepositories.id,
			name: archiveRepositories.name,
			active: archiveRepositories.active
		})
		.from(archiveRepositories)
		.orderBy(asc(archiveRepositories.name));
	return { repositories: rows };
}

export async function listArchiveUsers(db: Db): Promise<ArchiveAdminUser[]> {
	const rows = await db
		.select({
			userId: user.id,
			name: user.name,
			email: user.email,
			role: appUserRoles.role,
			roleUpdatedAt: appUserRoles.updatedAt,
			cachedLogin: githubLoginCache.login
		})
		.from(user)
		.leftJoin(appUserRoles, eq(appUserRoles.userId, user.id))
		.leftJoin(githubLoginCache, eq(githubLoginCache.userId, user.id))
		.orderBy(asc(user.name), asc(user.email))
		// Flat list sized for the current admin population; add cursoring if the archive user count grows past this.
		.limit(200);
	const identities = await db
		.select({
			userId: userIdentities.userId,
			kind: userIdentities.kind,
			value: userIdentities.value
		})
		.from(userIdentities)
		.where(inArray(userIdentities.kind, ['github_login', 'service_token']));
	const identityByUser = new Map<string, { githubLogin?: string; serviceToken?: string }>();
	for (const identity of identities) {
		const entry = identityByUser.get(identity.userId) ?? {};
		if (identity.kind === 'github_login') entry.githubLogin = identity.value;
		if (identity.kind === 'service_token') entry.serviceToken = identity.value;
		identityByUser.set(identity.userId, entry);
	}
	return rows.map((row) => {
		const identity = identityByUser.get(row.userId);
		const role = isArchiveRole(row.role) ? row.role : null;
		return {
			userId: row.userId,
			name: row.name,
			email: row.email,
			role,
			roleUpdatedAt: role ? iso(row.roleUpdatedAt) : null,
			login: row.cachedLogin ?? identity?.githubLogin ?? null,
			serviceToken: identity?.serviceToken ?? null,
			kind: classifyArchiveUserKind({
				userId: row.userId,
				email: row.email,
				serviceToken: identity?.serviceToken ?? null
			})
		};
	});
}

export async function getArchiveUserKind(db: Db, userId: string): Promise<ArchiveUserKind> {
	const [row] = await db
		.select({
			userId: user.id,
			email: user.email,
			serviceToken: userIdentities.value
		})
		.from(user)
		.leftJoin(
			userIdentities,
			and(eq(userIdentities.userId, user.id), eq(userIdentities.kind, 'service_token'))
		)
		.where(eq(user.id, userId))
		.limit(1);
	if (!row) throw new ArchiveHttpError(404, 'user not found');
	return classifyArchiveUserKind(row);
}

export async function setArchiveUserRole(
	db: Db,
	targetUserId: string,
	role: ArchiveRole | null,
	principal: ArchivePrincipal
): Promise<{ userId: string; role: ArchiveRole | null }> {
	return db.transaction(async (tx) => {
		const [target] = await tx
			.select({ id: user.id, email: user.email })
			.from(user)
			.where(eq(user.id, targetUserId))
			.limit(1);
		if (!target) throw new ArchiveHttpError(404, 'user not found');
		if (classifyArchiveUserKind({ userId: target.id, email: target.email }) === 'system') {
			throw new ArchiveHttpError(400, 'cannot change role for a system account');
		}

		const [current] = await tx
			.select({ role: appUserRoles.role })
			.from(appUserRoles)
			.where(eq(appUserRoles.userId, targetUserId))
			.limit(1);
		const previousRole = isArchiveRole(current?.role) ? current.role : null;

		if (previousRole === 'archive_admin' && role !== 'archive_admin') {
			const [{ adminCount }] = await tx
				.select({ adminCount: sql<number>`count(*)` })
				.from(appUserRoles)
				.where(eq(appUserRoles.role, 'archive_admin'));
			if (Number(adminCount) === 1) throw new ArchiveHttpError(409, 'cannot remove the last archive_admin');
		}

		if (role === null) {
			await tx.delete(appUserRoles).where(eq(appUserRoles.userId, targetUserId));
		} else {
			await tx
				.insert(appUserRoles)
				.values({ userId: targetUserId, role })
				.onConflictDoUpdate({
					target: appUserRoles.userId,
					set: { role, updatedAt: new Date() }
				});
		}

		await recordArchiveEvent(tx, {
			entityType: 'user',
			entityId: targetUserId,
			eventType: 'archive_role_changed',
			actor: principal.userId,
			details: { previousRole, newRole: role }
		});
		return { userId: targetUserId, role };
	});
}

export async function getSourceFileById(db: Db, fileId: string, principal: ArchivePrincipal) {
	const [row] = await db
		.select({
			fileId: sourceFiles.id,
			sourceId: sourceFiles.sourceId,
			sourceSlug: sources.slug,
			role: sourceFiles.role,
			checkoutPath: sourceFiles.checkoutPath,
			currentRevisionId: sql<string | null>`(
				select id from file_revisions cur
				where cur.source_file_id = ${sourceFiles.id} and cur.is_current = 1
				limit 1
			)`,
			pendingRevisionId: sql<string | null>`(
				select id from file_revisions pending
				where pending.source_file_id = ${sourceFiles.id} and pending.review_status = 'pending'
				limit 1
			)`
		})
		.from(sourceFiles)
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.where(eq(sourceFiles.id, fileId))
		.limit(1);
	if (!row) throw new ArchiveHttpError(404, 'file not found');
	return {
		...row,
		pendingRevisionId: archiveRoleAtLeast(principal.role, 'archive_reviewer') ? row.pendingRevisionId : null
	};
}

export async function getRevision(db: Db, id: string, principal: ArchivePrincipal) {
	const [row] = await db
		.select({
			id: fileRevisions.id,
			sourceFileId: fileRevisions.sourceFileId,
			sourceSlug: sources.slug,
			sourceId: sources.id,
			title: sources.title,
			role: sourceFiles.role,
			checkoutPath: sourceFiles.checkoutPath,
			revisionNo: fileRevisions.revisionNo,
			sha256: fileRevisions.blobSha256,
			bytes: archiveBlobs.bytes,
			declaredMediaType: fileRevisions.declaredMediaType,
			detectedMediaType: archiveBlobs.detectedMediaType,
			originalFilename: fileRevisions.originalFilename,
			pageCount: fileRevisions.pageCount,
			reviewStatus: fileRevisions.reviewStatus,
			accessState: fileRevisions.accessState,
			isCurrent: fileRevisions.isCurrent,
			submittedBy: fileRevisions.submittedBy,
			submittedAt: fileRevisions.submittedAt,
			reviewedBy: fileRevisions.reviewedBy,
			reviewedAt: fileRevisions.reviewedAt,
			reviewNote: fileRevisions.reviewNote,
			humanDownload: sources.humanDownload
		})
		.from(fileRevisions)
		.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(eq(fileRevisions.id, id))
		.limit(1);
	if (!row) throw new ArchiveHttpError(404, 'revision not found');
	requireReviewReadable(principal, row.reviewStatus, row.submittedBy);
	return {
		...row,
		submittedAt: iso(row.submittedAt),
		reviewedAt: iso(row.reviewedAt)
	};
}

export async function getRevisionForContent(
	db: Db,
	id: string,
	principal: ArchivePrincipal,
	opts: { requireDownloadRight?: boolean } = {}
) {
	const row = await getRevision(db, id, principal);
	requireAccessState(principal, row.accessState);
	if (opts.requireDownloadRight !== false && !row.humanDownload && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
		throw new ArchiveHttpError(403, 'source rights do not allow human download');
	}
	return row;
}

export async function createUploadSession(
	db: Db,
	principal: ArchivePrincipal,
	input: {
		sourceSlug: string;
		role: string;
		checkoutRepo?: string | null;
		checkoutPath?: string | null;
		bytes: number;
		sha256: string;
		declaredMediaType: string;
	}
) {
	if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new ArchiveHttpError(400, 'sha256 must be 64 lowercase hex characters');
	if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new ArchiveHttpError(400, 'size must be positive');
	const now = new Date();
	return db.transaction(async (tx) => {
		const slot = await resolveUploadSourceFile(tx, principal, input);
		const [blob] = await tx.select().from(archiveBlobs).where(eq(archiveBlobs.sha256, input.sha256)).limit(1);
		if (blob?.storageState === 'verified') {
			const revisionNo = await nextRevisionNo(tx, slot.id);
			const [revision] = await tx
				.insert(fileRevisions)
				.values({
					id: uuid(),
					sourceFileId: slot.id,
					revisionNo,
					blobSha256: input.sha256,
					originalFilename: originalFilenameFor(slot, input.sha256, input.declaredMediaType, input.checkoutPath),
					declaredMediaType: input.declaredMediaType,
					artifactKind: 'original',
					reviewStatus: 'pending',
					isCurrent: false,
					submittedBy: principal.userId,
					submittedAt: now
				})
				.returning();
			await recordArchiveEvent(tx, {
				entityType: 'file_revision',
				entityId: revision.id,
				eventType: 'revision_deduplicated',
				actor: principal.userId,
				details: { source_file_id: slot.id, sha256: input.sha256, bytes: blob.bytes }
			});
			return { kind: 'deduplicated' as const, revision, sourceFile: slot };
		}
		const [session] = await tx
			.insert(uploadSessions)
			.values({
				id: uuid(),
				sourceFileId: slot.id,
				expectedSha256: input.sha256,
				expectedBytes: input.bytes,
				declaredMediaType: input.declaredMediaType,
				stagingKey: `staging/${uuid()}`,
				state: 'initiated',
				submittedBy: principal.userId,
				createdAt: now,
				updatedAt: now,
				expiresAt: new Date(now.getTime() + DEFAULT_UPLOAD_TTL_MS)
			})
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'upload_session',
			entityId: session.id,
			eventType: 'upload_created',
			actor: principal.userId,
			details: { source_file_id: slot.id, sha256: input.sha256, bytes: input.bytes }
		});
		return { kind: 'session' as const, session, sourceFile: slot };
	});
}

export async function attachDataplaneUpload(
	db: Db,
	sessionId: string,
	input: { stagingKey: string; multipartId: string }
) {
	const [updated] = await db
		.update(uploadSessions)
		.set({
			stagingKey: input.stagingKey,
			multipartId: input.multipartId,
			state: 'uploading',
			updatedAt: new Date(),
			errorCode: null
		})
		.where(eq(uploadSessions.id, sessionId))
		.returning();
	if (!updated) throw new ArchiveHttpError(404, 'upload not found');
	return serializeUploadSession(updated);
}

export async function markUploadSessionFailed(db: Db, sessionId: string, errorCode: string) {
	const [updated] = await db
		.update(uploadSessions)
		.set({ state: 'failed', errorCode, updatedAt: new Date() })
		.where(eq(uploadSessions.id, sessionId))
		.returning();
	if (!updated) throw new ArchiveHttpError(404, 'upload not found');
	return serializeUploadSession(updated);
}

export async function getUploadSession(db: Db, id: string, principal: ArchivePrincipal) {
	const [row] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
	if (!row) throw new ArchiveHttpError(404, 'upload not found');
	if (row.submittedBy !== principal.userId && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
		throw new ArchiveHttpError(404, 'upload not found');
	}
	return serializeUploadSession(row);
}

export async function listUploadSessions(
	db: Db,
	principal: ArchivePrincipal,
	options: { states?: string[] | null; all?: boolean } = {}
) {
	const states = parseUploadSessionStates(options.states);
	const clauses = [inArray(uploadSessions.state, states)];
	if (!(options.all && principal.role === 'archive_admin')) clauses.push(eq(uploadSessions.submittedBy, principal.userId));
	// Upload resume lists are short-lived and small, so a fixed cap avoids cursor
	// plumbing on a list that normally has only a few active rows.
	const rows = await db
		.select()
		.from(uploadSessions)
		.where(and(...clauses))
		.orderBy(desc(uploadSessions.createdAt))
		.limit(100);
	return { uploads: rows.map(serializeUploadSession) };
}

function parseUploadSessionStates(values: string[] | null | undefined): UploadSessionState[] {
	if (!values || values.length === 0) return ['initiated', 'uploading', 'uploaded', 'finalizing'];
	for (const value of values) {
		if (!(UPLOAD_SESSION_STATES as readonly string[]).includes(value)) {
			throw new ArchiveHttpError(400, 'invalid upload state');
		}
	}
	return values as UploadSessionState[];
}

export async function reconcileUploadFinalization(
	db: Db,
	sessionId: string,
	principal: ArchivePrincipal,
	finalize: { status: number; body: unknown }
) {
	if (finalize.status === 404) return getUploadSession(db, sessionId, principal);
	if (isFinalizeSuccessResult(finalize.body)) {
		const result = finalize.body;
		if (result.sessionId !== sessionId) return getUploadSession(db, sessionId, principal);
		return db.transaction(async (tx) => {
			const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1);
			if (!session) throw new ArchiveHttpError(404, 'upload not found');
			if (session.submittedBy !== principal.userId && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
				throw new ArchiveHttpError(404, 'upload not found');
			}
			if (session.state === 'verified') return serializeUploadSession(session);

			const [sourceFile] = await tx
				.select({ label: sourceFiles.label, checkoutPath: sourceFiles.checkoutPath })
				.from(sourceFiles)
				.where(eq(sourceFiles.id, session.sourceFileId))
				.limit(1);
			if (!sourceFile) throw new ArchiveHttpError(500, 'source file not found');

			const now = new Date();
			await tx
				.insert(archiveBlobs)
				.values({
					sha256: result.sha256,
					bytes: result.bytes,
					detectedMediaType: result.detectedMediaType,
					storageState: 'verified',
					verifiedAt: now,
					createdBy: session.submittedBy
				})
				.onConflictDoNothing({ target: archiveBlobs.sha256 });

			// Upload creation does not carry a browser filename yet. This fallback
			// preserves a readable value for the required column until that field is
			// added to the wire contract.
			const originalFilename = originalFilenameFor(sourceFile, result.sha256, session.declaredMediaType);
			await tx.insert(fileRevisions).values({
				id: uuid(),
				sourceFileId: session.sourceFileId,
				revisionNo: await nextRevisionNo(tx, session.sourceFileId),
				blobSha256: result.sha256,
				originalFilename,
				declaredMediaType: session.declaredMediaType,
				artifactKind: 'original',
				reviewStatus: 'pending',
				isCurrent: false,
				submittedBy: session.submittedBy,
				submittedAt: now
			});
			const [updated] = await tx
				.update(uploadSessions)
				.set({ state: 'verified', errorCode: null, updatedAt: now })
				.where(eq(uploadSessions.id, sessionId))
				.returning();
			await recordArchiveEvent(tx, {
				entityType: 'upload_session',
				entityId: sessionId,
				eventType: 'upload_verified',
				actor: principal.userId
			});
			return serializeUploadSession(updated);
		});
	}

	if (!isFinalizeMismatchResult(finalize.body)) return getUploadSession(db, sessionId, principal);
	const result = finalize.body;
	if (result.sessionId !== sessionId) return getUploadSession(db, sessionId, principal);
	return db.transaction(async (tx) => {
		const [session] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, sessionId)).limit(1);
		if (!session) throw new ArchiveHttpError(404, 'upload not found');
		if (session.submittedBy !== principal.userId && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
			throw new ArchiveHttpError(404, 'upload not found');
		}
		if (session.state === 'failed') return serializeUploadSession(session);
		const [updated] = await tx
			.update(uploadSessions)
			.set({ state: 'failed', errorCode: result.reason, updatedAt: new Date() })
			.where(eq(uploadSessions.id, sessionId))
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'upload_session',
			entityId: sessionId,
			eventType: 'upload_quarantined',
			actor: principal.userId,
			details: {
				expectedSha256: result.expectedSha256,
				actualSha256: result.actualSha256,
				expectedBytes: result.expectedBytes,
				actualBytes: result.actualBytes
			}
		});
		return serializeUploadSession(updated);
	});
}

export async function completeUploadSession(db: Db, id: string, principal: ArchivePrincipal) {
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
		if (!row) throw new ArchiveHttpError(404, 'upload not found');
		if (row.submittedBy !== principal.userId) throw new ArchiveHttpError(403, 'upload owner required');
		if (!['initiated', 'uploading'].includes(row.state)) throw new ArchiveHttpError(409, 'upload is not completable');
		const [updated] = await tx
			.update(uploadSessions)
			.set({ state: 'uploaded', updatedAt: new Date() })
			.where(eq(uploadSessions.id, id))
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'upload_session',
			entityId: id,
			eventType: 'upload_completed',
			actor: principal.userId
		});
		return updated;
	});
}

export async function abortUploadSession(db: Db, id: string, principal: ArchivePrincipal) {
	return db.transaction(async (tx) => {
		const [row] = await tx.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
		if (!row) throw new ArchiveHttpError(404, 'upload not found');
		if (row.submittedBy !== principal.userId && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
			throw new ArchiveHttpError(403, 'upload owner required');
		}
		const [updated] = await tx
			.update(uploadSessions)
			.set({ state: 'aborted', updatedAt: new Date() })
			.where(eq(uploadSessions.id, id))
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'upload_session',
			entityId: id,
			eventType: 'upload_aborted',
			actor: principal.userId
		});
		return updated;
	});
}

export async function listPendingReview(db: Db, cursorRaw: string | null, limit = 50, options: { include?: 'full' } = {}) {
	const cursor = decodeCursor(cursorRaw);
	const clauses = [eq(fileRevisions.reviewStatus, 'pending')];
	if (cursor) {
		const d = new Date(cursor.updatedAt);
		clauses.push(or(gt(fileRevisions.submittedAt, d), and(eq(fileRevisions.submittedAt, d), gt(fileRevisions.id, cursor.id)))!);
	}
	const [rows, [{ total }]] = await Promise.all([
		db
			.select({
				revisionId: fileRevisions.id,
				sourceFileId: fileRevisions.sourceFileId,
				sourceSlug: sources.slug,
				title: sources.title,
				titleEn: sources.titleEn,
				fileRole: sourceFiles.role,
				checkoutPath: sourceFiles.checkoutPath,
				uploader: fileRevisions.submittedBy,
				submittedAt: fileRevisions.submittedAt,
				filename: fileRevisions.originalFilename,
				declaredMediaType: fileRevisions.declaredMediaType,
				detectedMediaType: archiveBlobs.detectedMediaType,
				bytes: archiveBlobs.bytes,
				pageCount: fileRevisions.pageCount,
				sha256: fileRevisions.blobSha256,
				currentRevision: sql<string | null>`(
					select id from file_revisions cur
					where cur.source_file_id = ${sourceFiles.id} and cur.is_current = 1
					limit 1
				)`
			})
			.from(fileRevisions)
			.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
			.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
			.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
			.where(and(...clauses))
			.orderBy(asc(fileRevisions.submittedAt), asc(fileRevisions.id))
			.limit(limit + 1),
		db
			.select({ total: sql<number>`count(*)` })
			.from(fileRevisions)
			.where(eq(fileRevisions.reviewStatus, 'pending'))
	]);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const full = options.include === 'full' ? await reviewFullPayload(db, page) : null;
	return {
		items: page.map((r) => {
			const { sourceFileId, ...publicRow } = r;
			const base = {
				...publicRow,
				submittedAt: iso(r.submittedAt),
				exactDuplicates: full?.exactDuplicates.get(r.revisionId) ?? []
			};
			if (!full) return base;
			return {
				...base,
				currentRevisionSummary: full.currentRevisionSummary.get(sourceFileId) ?? null,
				priorRevisions: full.priorRevisions.get(r.revisionId) ?? []
			};
		}),
		nextCursor:
			rows.length > limit && last?.submittedAt
				? encodeCursor({ updatedAt: last.submittedAt.toISOString(), id: last.revisionId })
				: null,
		total: Number(total)
	};
}

async function reviewFullPayload(
	db: Db,
	page: {
		revisionId: string;
		sourceFileId: string;
		sha256: string | null;
	}[]
) {
	if (page.length === 0) {
		return {
			exactDuplicates: new Map<string, unknown[]>(),
			currentRevisionSummary: new Map<string, unknown>(),
			priorRevisions: new Map<string, unknown[]>()
		};
	}
	const revisionIds = page.map((row) => row.revisionId);
	const sourceFileIds = [...new Set(page.map((row) => row.sourceFileId))];
	const sha256s = [...new Set(page.flatMap((row) => (row.sha256 ? [row.sha256] : [])))];
	const [duplicateRows, currentRows, priorRows] = await Promise.all([
		sha256s.length
			? db
					.select({
						revisionId: fileRevisions.id,
						sourceFileId: fileRevisions.sourceFileId,
						sourceSlug: sources.slug,
						reviewStatus: fileRevisions.reviewStatus,
						sha256: fileRevisions.blobSha256
					})
					.from(fileRevisions)
					.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
					.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
					.where(inArray(fileRevisions.blobSha256, sha256s))
			: [],
		db
			.select({
				id: fileRevisions.id,
				sourceFileId: fileRevisions.sourceFileId,
				revisionNo: fileRevisions.revisionNo,
				submittedAt: fileRevisions.submittedAt,
				reviewedAt: fileRevisions.reviewedAt,
				bytes: archiveBlobs.bytes,
				sha256: fileRevisions.blobSha256
			})
			.from(fileRevisions)
			.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
			.where(and(inArray(fileRevisions.sourceFileId, sourceFileIds), eq(fileRevisions.isCurrent, true))),
		db
			.select({
				id: fileRevisions.id,
				sourceFileId: fileRevisions.sourceFileId,
				revisionNo: fileRevisions.revisionNo,
				reviewStatus: fileRevisions.reviewStatus,
				reviewedBy: fileRevisions.reviewedBy,
				reviewedAt: fileRevisions.reviewedAt,
				reviewNote: fileRevisions.reviewNote,
				submittedAt: fileRevisions.submittedAt
			})
			.from(fileRevisions)
			.where(inArray(fileRevisions.sourceFileId, sourceFileIds))
			.orderBy(desc(fileRevisions.revisionNo))
	]);
	const pageByRevision = new Map(page.map((row) => [row.revisionId, row]));
	const exactDuplicates = new Map<string, { revisionId: string; sourceFileId: string; sourceSlug: string; reviewStatus: string }[]>();
	for (const row of page) exactDuplicates.set(row.revisionId, []);
	for (const duplicate of duplicateRows) {
		for (const row of page) {
			if (duplicate.sha256 === row.sha256 && duplicate.revisionId !== row.revisionId) {
				exactDuplicates.get(row.revisionId)?.push({
					revisionId: duplicate.revisionId,
					sourceFileId: duplicate.sourceFileId,
					sourceSlug: duplicate.sourceSlug,
					reviewStatus: duplicate.reviewStatus
				});
			}
		}
	}
	const currentRevisionSummary = new Map(
		currentRows.map((row) => [
			row.sourceFileId,
			{
				id: row.id,
				revisionNo: row.revisionNo,
				submittedAt: iso(row.submittedAt),
				reviewedAt: iso(row.reviewedAt),
				bytes: row.bytes,
				sha256: row.sha256
			}
		])
	);
	const priorRevisions = new Map<
		string,
		{
			id: string;
			revisionNo: number;
			reviewStatus: string;
			reviewedBy: string | null;
			reviewedAt: string | null;
			reviewNote: string | null;
			submittedAt: string | null;
		}[]
	>();
	for (const row of page) priorRevisions.set(row.revisionId, []);
	for (const prior of priorRows) {
		for (const [revisionId, row] of pageByRevision) {
			if (prior.sourceFileId === row.sourceFileId && prior.id !== revisionId) {
				priorRevisions.get(revisionId)?.push({
					id: prior.id,
					revisionNo: prior.revisionNo,
					reviewStatus: prior.reviewStatus,
					reviewedBy: prior.reviewedBy,
					reviewedAt: iso(prior.reviewedAt),
					reviewNote: prior.reviewNote,
					submittedAt: iso(prior.submittedAt)
				});
			}
		}
	}
	return { exactDuplicates, currentRevisionSummary, priorRevisions };
}

export async function approveRevision(db: Db, revisionId: string, principal: ArchivePrincipal) {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				revisionId: fileRevisions.id,
				sourceFileId: fileRevisions.sourceFileId,
				submittedBy: fileRevisions.submittedBy,
				reviewStatus: fileRevisions.reviewStatus,
				reviewedBy: fileRevisions.reviewedBy,
				reviewedAt: fileRevisions.reviewedAt,
				reviewNote: fileRevisions.reviewNote,
				declaredMediaType: fileRevisions.declaredMediaType,
				detectedMediaType: archiveBlobs.detectedMediaType,
				humanDownload: sources.humanDownload
			})
			.from(fileRevisions)
			.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
			.innerJoin(sourceFiles, eq(fileRevisions.sourceFileId, sourceFiles.id))
			.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
			.where(eq(fileRevisions.id, revisionId))
			.limit(1);
		if (!row) throw new ArchiveHttpError(404, 'revision not found');
		if (row.reviewStatus !== 'pending') {
			throw new ArchiveHttpError(409, 'revision already decided', alreadyDecidedDetails(row));
		}
		if (row.submittedBy === principal.userId) throw new ArchiveHttpError(403, 'reviewer must differ from submitter');
		if (row.declaredMediaType !== row.detectedMediaType) throw new ArchiveHttpError(409, 'declared media type does not match detected media type');
		if (!row.humanDownload) throw new ArchiveHttpError(403, 'source rights do not allow approval');
		await tx.update(fileRevisions).set({ isCurrent: false }).where(eq(fileRevisions.sourceFileId, row.sourceFileId));
		const [updated] = await tx
			.update(fileRevisions)
			.set({
				reviewStatus: 'approved',
				isCurrent: true,
				reviewedBy: principal.userId,
				reviewedAt: new Date()
			})
			.where(eq(fileRevisions.id, revisionId))
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'file_revision',
			entityId: revisionId,
			eventType: 'revision_approved',
			actor: principal.userId
		});
		return updated;
	});
}

export async function rejectRevision(db: Db, revisionId: string, principal: ArchivePrincipal, note: string) {
	if (!note.trim()) throw new ArchiveHttpError(400, 'review note is required');
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				reviewStatus: fileRevisions.reviewStatus,
				reviewedBy: fileRevisions.reviewedBy,
				reviewedAt: fileRevisions.reviewedAt,
				reviewNote: fileRevisions.reviewNote
			})
			.from(fileRevisions)
			.where(eq(fileRevisions.id, revisionId))
			.limit(1);
		if (!row) throw new ArchiveHttpError(404, 'revision not found');
		if (row.reviewStatus !== 'pending') {
			throw new ArchiveHttpError(409, 'revision already decided', alreadyDecidedDetails(row));
		}
		const [updated] = await tx
			.update(fileRevisions)
			.set({ reviewStatus: 'rejected', reviewedBy: principal.userId, reviewedAt: new Date(), reviewNote: note })
			.where(eq(fileRevisions.id, revisionId))
			.returning();
		await recordArchiveEvent(tx, {
			entityType: 'file_revision',
			entityId: revisionId,
			eventType: 'revision_rejected',
			actor: principal.userId,
			details: { note }
		});
		return updated;
	});
}

export async function withdrawRevision(db: Db, revisionId: string, principal: ArchivePrincipal) {
	const [updated] = await db
		.update(fileRevisions)
		.set({ reviewStatus: 'withdrawn' })
		.where(
			and(
				eq(fileRevisions.id, revisionId),
				eq(fileRevisions.reviewStatus, 'pending'),
				eq(fileRevisions.submittedBy, principal.userId)
			)
		)
		.returning();
	if (!updated) throw new ArchiveHttpError(404, 'own pending revision not found');
	await recordArchiveEvent(db, {
		entityType: 'file_revision',
		entityId: revisionId,
		eventType: 'revision_withdrawn',
		actor: principal.userId
	});
	return updated;
}

export function capabilityExpiry(requestedTtlSeconds: number | undefined, now = new Date()): Date {
	const ttl = Math.min(Math.max(Number(requestedTtlSeconds) || 120, 1), 120);
	return new Date(now.getTime() + ttl * 1000);
}

export async function issueCapability(db: Db, revisionId: string, principal: ArchivePrincipal, ttlSeconds?: number) {
	if (principal.authn === 'mcp_assertion') {
		throw new ArchiveHttpError(403, 'assertion-authenticated principals cannot issue capabilities');
	}
	const revision = await getRevisionForContent(db, revisionId, principal);
	if (!archiveRoleAtLeast(principal.role, 'archive_reviewer') && revision.submittedBy !== principal.userId) {
		throw new ArchiveHttpError(403, 'capability issuance is not allowed');
	}
	const jti = uuid();
	const [row] = await db
		.insert(capabilityTokens)
		.values({
			jti,
			revisionId,
			userId: principal.userId,
			expiresAt: capabilityExpiry(ttlSeconds),
			maxBytes: revision.bytes,
			createdAt: new Date()
		})
		.returning();
	await recordArchiveEvent(db, {
		entityType: 'capability_token',
		entityId: jti,
		eventType: 'capability_issued',
		actor: principal.userId,
		details: { revision_id: revisionId, max_bytes: revision.bytes }
	});
	return { ...row, bearer: jti, expiresAt: iso(row.expiresAt) };
}

function parseCapabilityRedemption(
	request: CapabilityRedemptionRequest
):
	| { ok: true; bytesSql: ReturnType<typeof sql>; detailsBytes: number | 'full' | 'range' }
	| { ok: false; status: number; message: string } {
	if (request.kind === 'full' || !request.rangeHeader) {
		return { ok: true, bytesSql: sql`${capabilityTokens.maxBytes}`, detailsBytes: 'full' };
	}
	const m = /^bytes=(\d*)-(\d*)$/u.exec(request.rangeHeader.trim());
	if (!m) return { ok: false, status: 416, message: 'invalid range' };
	const [, rawStart, rawEnd] = m;
	if (!rawStart && !rawEnd) return { ok: false, status: 416, message: 'invalid range' };
	if (!rawStart) {
		const suffix = Number(rawEnd);
		if (!Number.isSafeInteger(suffix) || suffix <= 0) return { ok: false, status: 416, message: 'invalid range' };
		return { ok: true, bytesSql: sql`min(${suffix}, ${capabilityTokens.maxBytes})`, detailsBytes: 'range' };
	}
	const start = Number(rawStart);
	if (!Number.isSafeInteger(start) || start < 0) return { ok: false, status: 416, message: 'invalid range' };
	if (!rawEnd) {
		return {
			ok: true,
			bytesSql: sql`${capabilityTokens.maxBytes} - ${start}`,
			detailsBytes: 'range'
		};
	}
	const end = Number(rawEnd);
	if (!Number.isSafeInteger(end) || end < start) return { ok: false, status: 416, message: 'invalid range' };
	return {
		ok: true,
		bytesSql: sql`min(${end}, ${capabilityTokens.maxBytes} - 1) - ${start} + 1`,
		detailsBytes: 'range'
	};
}

function chargedBytesForRequest(request: CapabilityRedemptionRequest, maxBytes: number): number {
	if (request.kind === 'full' || !request.rangeHeader) return maxBytes;
	const m = /^bytes=(\d*)-(\d*)$/u.exec(request.rangeHeader.trim());
	if (!m) throw new ArchiveHttpError(416, 'invalid range');
	const [, rawStart, rawEnd] = m;
	if (!rawStart && !rawEnd) throw new ArchiveHttpError(416, 'invalid range');
	if (!rawStart) return Math.min(Number(rawEnd), maxBytes);
	const start = Number(rawStart);
	if (!rawEnd) return maxBytes - start;
	return Math.min(Number(rawEnd), maxBytes - 1) - start + 1;
}

export async function redeemCapability(db: Db, bearer: string, request: CapabilityRedemptionRequest) {
	if (!bearer) throw new ArchiveHttpError(401, 'invalid capability');
	const parsed = parseCapabilityRedemption(request);
	if (!parsed.ok) throw new ArchiveHttpError(parsed.status, parsed.message);
	return db.transaction(async (tx) => {
		const now = new Date();
		const [reserved] = await tx
			.update(capabilityTokens)
			.set({
				bytesServed: sql`${capabilityTokens.bytesServed} + ${parsed.bytesSql}`,
				redeemedAt: now
			})
			.where(
				and(
					eq(capabilityTokens.jti, bearer),
					isNull(capabilityTokens.revokedAt),
					gt(capabilityTokens.expiresAt, now),
					sql`${parsed.bytesSql} > 0`,
					sql`${capabilityTokens.bytesServed} + ${parsed.bytesSql} <= ${capabilityTokens.maxBytes}`
				)
			)
			.returning();
		if (!reserved) throw new ArchiveHttpError(401, 'invalid capability');
		const principal: ArchivePrincipal = {
			userId: reserved.userId,
			role: 'archive_reader',
			identity: { kind: 'service_token', value: 'capability' },
			authn: 'service_token'
		};
		return {
			token: reserved,
			principal,
			revisionId: reserved.revisionId,
			chargedBytes: chargedBytesForRequest(request, reserved.maxBytes),
			redemptionKind: parsed.detailsBytes
		};
	});
}

export async function reserveStreamQuota(
	db: Db,
	principal: ArchivePrincipal,
	revisionId: string,
	bytes: number,
	budgetKind: ArchiveBudgetKind = 'download'
): Promise<{ leaseId: string | null; reserved: number; remaining: number; resetAt: string; budgetKind: ArchiveBudgetKind }> {
	const dailyLimit =
		budgetKind === 'download'
			? intEnv('ARCHIVE_DAILY_BYTE_LIMIT', DEFAULT_DAILY_BYTES)
			: intEnv('ARCHIVE_DAILY_VIEW_BYTE_LIMIT', DEFAULT_DAILY_VIEW_BYTES);
	const concurrencyLimit = intEnv('ARCHIVE_CONCURRENT_STREAM_LIMIT', DEFAULT_CONCURRENT_STREAMS);
	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
	return db.transaction(async (tx) => {
		if (budgetKind === 'download') {
			await tx.delete(archiveStreamLeases).where(lt(archiveStreamLeases.expiresAt, now));
			const [{ count }] = await tx
				.select({ count: sql<number>`count(*)` })
				.from(archiveStreamLeases)
				.where(eq(archiveStreamLeases.userId, principal.userId));
			if (Number(count) >= concurrencyLimit) {
				throw new ArchiveHttpError(429, 'concurrent stream limit reached', { resetAt });
			}
		}
		const [usage] = await tx
			.select()
			.from(archiveStreamDailyUsage)
			.where(
				and(
					eq(archiveStreamDailyUsage.userId, principal.userId),
					eq(archiveStreamDailyUsage.day, day),
					eq(archiveStreamDailyUsage.budgetKind, budgetKind)
				)
			)
			.limit(1);
		const reserved = (usage?.bytesReserved ?? 0) + bytes;
		if (reserved > dailyLimit) throw new ArchiveHttpError(429, 'daily byte budget exceeded', { resetAt });
		if (usage) {
			await tx
				.update(archiveStreamDailyUsage)
				.set({ bytesReserved: reserved, updatedAt: now })
				.where(
					and(
						eq(archiveStreamDailyUsage.userId, principal.userId),
						eq(archiveStreamDailyUsage.day, day),
						eq(archiveStreamDailyUsage.budgetKind, budgetKind)
					)
				);
		} else {
			await tx.insert(archiveStreamDailyUsage).values({
				userId: principal.userId,
				day,
				budgetKind,
				bytesReserved: bytes,
				updatedAt: now
			});
		}
		let leaseId: string | null = null;
		if (budgetKind === 'download') {
			leaseId = uuid();
			await tx.insert(archiveStreamLeases).values({
				id: leaseId,
				userId: principal.userId,
				revisionId,
				expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
				createdAt: now
			});
		}
		return { leaseId, reserved, remaining: dailyLimit - reserved, resetAt, budgetKind };
	});
}

export async function reserveContentApiRate(
	db: Db,
	principal: ArchivePrincipal,
	useKind: 'text' | 'search',
	units: number
): Promise<{ callsUsed: number; unitsUsed: number; resetAt: string }> {
	const callLimit =
		useKind === 'text'
			? intEnv('ARCHIVE_DAILY_TEXT_CALL_LIMIT', DEFAULT_TEXT_CALL_LIMIT)
			: intEnv('ARCHIVE_DAILY_SEARCH_CALL_LIMIT', DEFAULT_SEARCH_CALL_LIMIT);
	const unitLimit =
		useKind === 'text'
			? intEnv('ARCHIVE_DAILY_TEXT_PAGE_LIMIT', DEFAULT_TEXT_PAGE_LIMIT)
			: intEnv('ARCHIVE_DAILY_SEARCH_HIT_LIMIT', DEFAULT_SEARCH_HIT_LIMIT);
	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
	const safeUnits = Number.isSafeInteger(units) && units > 0 ? units : 0;
	return db.transaction(async (tx) => {
		const [usage] = await tx
			.select()
			.from(archiveContentApiDailyUsage)
			.where(
				and(
					eq(archiveContentApiDailyUsage.userId, principal.userId),
					eq(archiveContentApiDailyUsage.day, day),
					eq(archiveContentApiDailyUsage.useKind, useKind)
				)
			)
			.limit(1);
		const callsUsed = (usage?.calls ?? 0) + 1;
		const unitsUsed = (usage?.units ?? 0) + safeUnits;
		if (callsUsed > callLimit || unitsUsed > unitLimit) {
			throw new ArchiveHttpError(429, `${useKind} API daily limit exceeded`, { resetAt });
		}
		if (usage) {
			await tx
				.update(archiveContentApiDailyUsage)
				.set({ calls: callsUsed, units: unitsUsed, updatedAt: now })
				.where(
					and(
						eq(archiveContentApiDailyUsage.userId, principal.userId),
						eq(archiveContentApiDailyUsage.day, day),
						eq(archiveContentApiDailyUsage.useKind, useKind)
					)
				);
		} else {
			await tx.insert(archiveContentApiDailyUsage).values({
				userId: principal.userId,
				day,
				useKind,
				calls: callsUsed,
				units: unitsUsed,
				updatedAt: now
			});
		}
		return { callsUsed, unitsUsed, resetAt };
	});
}

export async function getUsageSummary(db: Db, principal: ArchivePrincipal) {
	const dailyLimit = intEnv('ARCHIVE_DAILY_BYTE_LIMIT', DEFAULT_DAILY_BYTES);
	const dailyViewByteLimit = intEnv('ARCHIVE_DAILY_VIEW_BYTE_LIMIT', DEFAULT_DAILY_VIEW_BYTES);
	const concurrencyLimit = intEnv('ARCHIVE_CONCURRENT_STREAM_LIMIT', DEFAULT_CONCURRENT_STREAMS);
	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	return db.transaction(async (tx) => {
		await tx.delete(archiveStreamLeases).where(lt(archiveStreamLeases.expiresAt, now));
		const [usage] = await tx
			.select()
			.from(archiveStreamDailyUsage)
			.where(
				and(
					eq(archiveStreamDailyUsage.userId, principal.userId),
					eq(archiveStreamDailyUsage.day, day),
					eq(archiveStreamDailyUsage.budgetKind, 'download')
				)
			)
			.limit(1);
		const [viewUsage] = await tx
			.select()
			.from(archiveStreamDailyUsage)
			.where(
				and(
					eq(archiveStreamDailyUsage.userId, principal.userId),
					eq(archiveStreamDailyUsage.day, day),
					eq(archiveStreamDailyUsage.budgetKind, 'view')
				)
			)
			.limit(1);
		const apiUsage = await tx
			.select()
			.from(archiveContentApiDailyUsage)
			.where(and(eq(archiveContentApiDailyUsage.userId, principal.userId), eq(archiveContentApiDailyUsage.day, day)));
		const textUsage = apiUsage.find((row) => row.useKind === 'text');
		const searchUsage = apiUsage.find((row) => row.useKind === 'search');
		const [{ activeStreams }] = await tx
			.select({ activeStreams: sql<number>`count(*)` })
			.from(archiveStreamLeases)
			.where(and(eq(archiveStreamLeases.userId, principal.userId), gt(archiveStreamLeases.expiresAt, now)));
		const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
		return {
			search_modes: [...DEPLOYED_SEARCH_MODES],
			date: day,
			bytesUsed: usage?.bytesReserved ?? 0,
			dailyByteLimit: dailyLimit,
			resetAt: resetAt.toISOString(),
			activeStreams: Number(activeStreams),
			concurrentStreamLimit: concurrencyLimit,
			viewBytesUsed: viewUsage?.bytesReserved ?? 0,
			dailyViewByteLimit,
			textCallsUsed: textUsage?.calls ?? 0,
			dailyTextCallLimit: intEnv('ARCHIVE_DAILY_TEXT_CALL_LIMIT', DEFAULT_TEXT_CALL_LIMIT),
			textPagesUsed: textUsage?.units ?? 0,
			dailyTextPageLimit: intEnv('ARCHIVE_DAILY_TEXT_PAGE_LIMIT', DEFAULT_TEXT_PAGE_LIMIT),
			searchCallsUsed: searchUsage?.calls ?? 0,
			dailySearchCallLimit: intEnv('ARCHIVE_DAILY_SEARCH_CALL_LIMIT', DEFAULT_SEARCH_CALL_LIMIT),
			searchHitsUsed: searchUsage?.units ?? 0,
			dailySearchHitLimit: intEnv('ARCHIVE_DAILY_SEARCH_HIT_LIMIT', DEFAULT_SEARCH_HIT_LIMIT)
		};
	});
}

type ArchiveListCursor =
	| { sort: 'updated'; updatedAt: string; id: string }
	| { sort: 'title'; title: string; id: string }
	| { sort: 'year-desc' | 'year-asc'; yearStart: number | null; id: string }
	| { sort: 'significance'; significance: number | null; id: string };

function encodeArchiveListCursor(cursor: ArchiveListCursor): string {
	return base64url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeArchiveListCursor(value: string | null, sort: ArchiveFileSort): ArchiveListCursor | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(fromBase64url(value))) as Record<string, unknown>;
		if (parsed.sort !== sort || typeof parsed.id !== 'string') return null;
		if (sort === 'updated') {
			return typeof parsed.updatedAt === 'string' ? { sort, updatedAt: parsed.updatedAt, id: parsed.id } : null;
		}
		if (sort === 'title') {
			return typeof parsed.title === 'string' ? { sort, title: parsed.title, id: parsed.id } : null;
		}
		if (sort === 'significance') {
			return typeof parsed.significance === 'number' || parsed.significance === null
				? { sort, significance: parsed.significance, id: parsed.id }
				: null;
		}
		if (typeof parsed.yearStart === 'number' || parsed.yearStart === null) return { sort, yearStart: parsed.yearStart, id: parsed.id };
		return null;
	} catch {
		return null;
	}
}

function likeNeedle(value: string): string {
	return `%${value.toLocaleLowerCase().replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
}

export async function listArchiveFiles(
	db: Db,
	input: {
		text?: string;
		dialect?: string;
		decade?: number;
		ocr?: 'with' | 'without';
		sort: ArchiveFileSort;
		cursor?: string | null;
		limit?: number;
		principal: ArchivePrincipal;
	}
) {
	const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
	const cursor = decodeArchiveListCursor(input.cursor ?? null, input.sort);
	if (input.cursor && !cursor) throw new ArchiveHttpError(400, 'invalid cursor');
	const clauses = [eq(fileRevisions.reviewStatus, 'approved'), eq(fileRevisions.isCurrent, true)];
	if (!archiveRoleAtLeast(input.principal.role, 'archive_reviewer')) {
		clauses.push(eq(fileRevisions.accessState, 'available'), eq(sources.humanDownload, true));
	} else if (input.principal.role !== 'archive_admin') {
		clauses.push(or(eq(fileRevisions.accessState, 'available'), eq(fileRevisions.accessState, 'embargoed'))!);
	}
	if (input.text?.trim()) {
		const needle = likeNeedle(input.text.trim());
		clauses.push(
			sql`(
				lower(${sources.title}) like ${needle} escape '\\'
				or lower(coalesce(${sources.titleEn}, '')) like ${needle} escape '\\'
				or lower(coalesce(${sources.titleAin}, '')) like ${needle} escape '\\'
				or lower(${sources.slug}) like ${needle} escape '\\'
				or lower(coalesce(${sources.author}, '')) like ${needle} escape '\\'
				or lower(coalesce(${sources.summary}, '')) like ${needle} escape '\\'
			)`
		);
	}
	if (input.dialect?.trim()) {
		clauses.push(sql`lower(coalesce(${sources.dialect}, '')) like ${likeNeedle(input.dialect.trim())} escape '\\'`);
	}
	if (input.decade) {
		clauses.push(gte(sources.yearStart, input.decade), lt(sources.yearStart, input.decade + 10));
	}
	if (input.ocr) {
		// A revision has text when any of its coverage rows is not 'none'.
		const hasText = sql`(select 1 from ${revisionOcrCoverage} where ${revisionOcrCoverage.revisionId} = ${fileRevisions.id} and ${revisionOcrCoverage.status} <> 'none')`;
		clauses.push(input.ocr === 'with' ? exists(hasText) : notExists(hasText));
	}
	if (cursor) {
		if (cursor.sort === 'updated') {
			const d = new Date(cursor.updatedAt);
			if (Number.isNaN(d.getTime())) throw new ArchiveHttpError(400, 'invalid cursor');
			clauses.push(
				or(
					lt(fileRevisions.reviewedAt, d),
					and(eq(fileRevisions.reviewedAt, d), gt(sourceFiles.id, cursor.id)),
					isNull(fileRevisions.reviewedAt)
				)!
			);
		} else if (cursor.sort === 'title') {
			clauses.push(or(gt(sources.title, cursor.title), and(eq(sources.title, cursor.title), gt(sourceFiles.id, cursor.id)))!);
		} else if (cursor.sort === 'year-desc') {
			clauses.push(
				cursor.yearStart == null
					? and(isNull(sources.yearStart), gt(sourceFiles.id, cursor.id))!
					: or(
							lt(sources.yearStart, cursor.yearStart),
							and(eq(sources.yearStart, cursor.yearStart), gt(sourceFiles.id, cursor.id)),
							isNull(sources.yearStart)
						)!
			);
		} else if (cursor.sort === 'significance') {
			clauses.push(
				cursor.significance == null
					? and(isNull(sources.significance), gt(sourceFiles.id, cursor.id))!
					: or(
							lt(sources.significance, cursor.significance),
							and(eq(sources.significance, cursor.significance), gt(sourceFiles.id, cursor.id)),
							isNull(sources.significance)
						)!
			);
		} else {
			clauses.push(
				cursor.yearStart == null
					? and(isNull(sources.yearStart), gt(sourceFiles.id, cursor.id))!
					: or(
							gt(sources.yearStart, cursor.yearStart),
							and(eq(sources.yearStart, cursor.yearStart), gt(sourceFiles.id, cursor.id)),
							isNull(sources.yearStart)
						)!
			);
		}
	}

	const orderBy =
		input.sort === 'title'
			? [asc(sources.title), asc(sourceFiles.id)]
			: input.sort === 'year-desc'
				? [sql`${sources.yearStart} is null`, desc(sources.yearStart), asc(sourceFiles.id)]
				: input.sort === 'year-asc'
					? [sql`${sources.yearStart} is null`, asc(sources.yearStart), asc(sourceFiles.id)]
					: input.sort === 'significance'
						? [sql`${sources.significance} is null`, desc(sources.significance), asc(sourceFiles.id)]
						: [sql`${fileRevisions.reviewedAt} is null`, desc(fileRevisions.reviewedAt), asc(sourceFiles.id)];

	const rows = await db
		.select({
			fileId: sourceFiles.id,
			sourceSlug: sources.slug,
			role: sourceFiles.role,
			checkoutPath: sourceFiles.checkoutPath,
			sortOrder: sourceFiles.sortOrder,
			revisionId: fileRevisions.id,
			reviewedAt: fileRevisions.reviewedAt,
			sha256: fileRevisions.blobSha256,
			bytes: archiveBlobs.bytes,
			mediaType: archiveBlobs.detectedMediaType,
			pageCount: fileRevisions.pageCount,
			sourceId: sources.id,
			title: sources.title,
			titleEn: sources.titleEn,
			titleAin: sources.titleAin,
			author: sources.author,
			yearText: sources.yearText,
			yearStart: sources.yearStart,
			yearEnd: sources.yearEnd,
			yearCertainty: sources.yearCertainty,
			dialect: sources.dialect,
			languages: sources.languages,
			significance: sources.significance,
			summary: sources.summary
		})
		.from(sourceFiles)
		.innerJoin(sources, eq(sourceFiles.sourceId, sources.id))
		.innerJoin(fileRevisions, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.innerJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(and(...clauses))
		.orderBy(...orderBy)
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	let nextCursor: string | null = null;
	if (rows.length > limit && last) {
		nextCursor =
			input.sort === 'title'
				? encodeArchiveListCursor({ sort: 'title', title: last.title, id: last.fileId })
				: input.sort === 'year-desc' || input.sort === 'year-asc'
					? encodeArchiveListCursor({ sort: input.sort, yearStart: last.yearStart, id: last.fileId })
					: input.sort === 'significance'
						? encodeArchiveListCursor({ sort: 'significance', significance: last.significance, id: last.fileId })
						: last.reviewedAt
							? encodeArchiveListCursor({ sort: 'updated', updatedAt: last.reviewedAt.toISOString(), id: last.fileId })
							: null;
	}
	return {
		items: page.map((row) => ({
			file: {
				fileId: row.fileId,
				sourceSlug: row.sourceSlug,
				role: row.role,
				checkoutPath: row.checkoutPath,
				sortOrder: row.sortOrder,
				revisionId: row.revisionId,
				reviewedAt: iso(row.reviewedAt),
				sha256: row.sha256,
				bytes: row.bytes,
				mediaType: row.mediaType,
				pageCount: row.pageCount
			},
			source: {
				id: row.sourceId,
				slug: row.sourceSlug,
				title: row.title,
				titleEn: row.titleEn,
				titleAin: row.titleAin,
				author: row.author,
				yearText: row.yearText,
				yearStart: row.yearStart,
				yearEnd: row.yearEnd,
				yearCertainty: row.yearCertainty,
				dialect: row.dialect,
				languages: row.languages,
				summary: row.summary
			},
			coverage: null
		})),
		nextCursor
	};
}

export async function listArchiveEvents(db: Db, cursorRaw: string | null, limit = 50) {
	const cursor = decodeCursor(cursorRaw);
	const clauses = [isNull(sourceLifecycleEvents.sourceId)];
	if (cursor) {
		const d = new Date(cursor.updatedAt);
		clauses.push(or(gt(sourceLifecycleEvents.createdAt, d), and(eq(sourceLifecycleEvents.createdAt, d), gt(sourceLifecycleEvents.id, cursor.id)))!);
	}
	const rows = await db
		.select()
		.from(sourceLifecycleEvents)
		.where(and(...clauses))
		.orderBy(asc(sourceLifecycleEvents.createdAt), asc(sourceLifecycleEvents.id))
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((r) => ({ ...r, createdAt: iso(r.createdAt) })),
		nextCursor:
			rows.length > limit && last?.createdAt
				? encodeCursor({ updatedAt: last.createdAt.toISOString(), id: last.id })
				: null
	};
}
