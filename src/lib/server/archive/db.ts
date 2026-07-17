import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { env } from '$env/dynamic/private';
import {
	appUserRoles,
	archiveBlobs,
	archiveRepositories,
	archiveStreamDailyUsage,
	archiveStreamLeases,
	capabilityTokens,
	fileRevisions,
	sourceFiles,
	sourceLifecycleEvents,
	sources,
	uploadSessions
} from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { recordArchiveEvent } from './audit';
import { ArchiveHttpError } from './errors';
import { decodeCursor, encodeCursor, type FileCursor } from './cursor';
import { archiveRoleAtLeast, iso, type ArchivePrincipal } from './types';

type Db = LibSQLDatabase<typeof schema>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_CONCURRENT_STREAMS = 3;

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

function requireReviewReadable(principal: ArchivePrincipal, reviewStatus: string, submittedBy: string): void {
	if (reviewStatus === 'approved') return;
	if (archiveRoleAtLeast(principal.role, 'archive_reviewer')) return;
	if (principal.role === 'archive_contributor' && submittedBy === principal.userId && reviewStatus === 'pending') return;
	throw new ArchiveHttpError(404, 'revision not found');
}

function requireAccessState(principal: ArchivePrincipal, accessState: string): void {
	if (accessState === 'available') return;
	if (accessState === 'embargoed' && archiveRoleAtLeast(principal.role, 'archive_reviewer')) return;
	if (accessState === 'takedown' && principal.role === 'archive_admin') return;
	throw new ArchiveHttpError(403, 'revision is not readable');
}

export async function listSourceFiles(db: Db, slug: string, principal: ArchivePrincipal) {
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
			and(
				eq(fileRevisions.sourceFileId, sourceFiles.id),
				archiveRoleAtLeast(principal.role, 'archive_reviewer')
					? or(eq(fileRevisions.isCurrent, true), eq(fileRevisions.reviewStatus, 'pending'))
					: eq(fileRevisions.isCurrent, true)
			)
		)
		.leftJoin(archiveBlobs, eq(fileRevisions.blobSha256, archiveBlobs.sha256))
		.where(eq(sources.slug, slug))
		.orderBy(asc(sourceFiles.sortOrder), asc(sourceFiles.id), desc(fileRevisions.submittedAt));
	return rows;
}

export async function listFiles(db: Db, cursorRaw: string | null, updatedSinceRaw: string | null, limit = 50) {
	const cursor = decodeCursor(cursorRaw);
	const updatedSince = updatedSinceRaw ? new Date(updatedSinceRaw) : null;
	if (updatedSinceRaw && Number.isNaN(updatedSince?.getTime())) throw new ArchiveHttpError(400, 'invalid updated_since');
	const clauses = [eq(fileRevisions.reviewStatus, 'approved'), eq(fileRevisions.isCurrent, true)];
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

export async function getRevisionForContent(db: Db, id: string, principal: ArchivePrincipal) {
	const row = await getRevision(db, id, principal);
	requireAccessState(principal, row.accessState);
	if (!row.humanDownload && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
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
	const duplicate = await db.select().from(archiveBlobs).where(eq(archiveBlobs.sha256, input.sha256)).limit(1);
	if (duplicate.length) throw new ArchiveHttpError(409, 'blob already exists');
	const now = new Date();
	return db.transaction(async (tx) => {
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
		return { session, sourceFile: slot };
	});
}

export async function getUploadSession(db: Db, id: string, principal: ArchivePrincipal) {
	const [row] = await db.select().from(uploadSessions).where(eq(uploadSessions.id, id)).limit(1);
	if (!row) throw new ArchiveHttpError(404, 'upload not found');
	if (row.submittedBy !== principal.userId && !archiveRoleAtLeast(principal.role, 'archive_reviewer')) {
		throw new ArchiveHttpError(404, 'upload not found');
	}
	return {
		...row,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
		expiresAt: iso(row.expiresAt)
	};
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

export async function listPendingReview(db: Db, cursorRaw: string | null, limit = 50) {
	const cursor = decodeCursor(cursorRaw);
	const clauses = [eq(fileRevisions.reviewStatus, 'pending')];
	if (cursor) {
		const d = new Date(cursor.updatedAt);
		clauses.push(or(gt(fileRevisions.submittedAt, d), and(eq(fileRevisions.submittedAt, d), gt(fileRevisions.id, cursor.id)))!);
	}
	const rows = await db
		.select({
			revisionId: fileRevisions.id,
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
		.limit(limit + 1);
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return {
		items: page.map((r) => ({ ...r, submittedAt: iso(r.submittedAt), exactDuplicates: [] })),
		nextCursor:
			rows.length > limit && last?.submittedAt
				? encodeCursor({ updatedAt: last.submittedAt.toISOString(), id: last.revisionId })
				: null
	};
}

export async function approveRevision(db: Db, revisionId: string, principal: ArchivePrincipal) {
	return db.transaction(async (tx) => {
		const [row] = await tx
			.select({
				revisionId: fileRevisions.id,
				sourceFileId: fileRevisions.sourceFileId,
				submittedBy: fileRevisions.submittedBy,
				reviewStatus: fileRevisions.reviewStatus,
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
		if (row.reviewStatus !== 'pending') throw new ArchiveHttpError(409, 'revision is not pending');
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
	const [updated] = await db
		.update(fileRevisions)
		.set({ reviewStatus: 'rejected', reviewedBy: principal.userId, reviewedAt: new Date(), reviewNote: note })
		.where(and(eq(fileRevisions.id, revisionId), eq(fileRevisions.reviewStatus, 'pending')))
		.returning();
	if (!updated) throw new ArchiveHttpError(409, 'revision is not pending');
	await recordArchiveEvent(db, {
		entityType: 'file_revision',
		entityId: revisionId,
		eventType: 'revision_rejected',
		actor: principal.userId,
		details: { note }
	});
	return updated;
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

export async function redeemCapability(db: Db, bearer: string, requestedBytes: number | 'all') {
	if (!bearer) throw new ArchiveHttpError(401, 'invalid capability');
	return db.transaction(async (tx) => {
		const now = new Date();
		const increment =
			requestedBytes === 'all'
				? sql`${capabilityTokens.maxBytes} - ${capabilityTokens.bytesServed}`
				: sql`${requestedBytes}`;
		const [reserved] = await tx
			.update(capabilityTokens)
			.set({
				bytesServed: sql`${capabilityTokens.bytesServed} + ${increment}`,
				redeemedAt: now
			})
			.where(
				and(
					eq(capabilityTokens.jti, bearer),
					isNull(capabilityTokens.revokedAt),
					gt(capabilityTokens.expiresAt, now),
					sql`${capabilityTokens.bytesServed} + ${increment} <= ${capabilityTokens.maxBytes}`
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
		const revision = await getRevisionForContent(tx as unknown as Db, reserved.revisionId, principal);
		await recordArchiveEvent(tx, {
			entityType: 'capability_token',
			entityId: reserved.jti,
			eventType: 'capability_redeemed',
			actor: reserved.userId,
			details: { revision_id: reserved.revisionId, bytes: requestedBytes === 'all' ? reserved.maxBytes : requestedBytes }
		});
		return { token: reserved, revision };
	});
}

export async function reserveStreamQuota(
	db: Db,
	principal: ArchivePrincipal,
	revisionId: string,
	bytes: number
): Promise<string> {
	const dailyLimit = intEnv('ARCHIVE_DAILY_BYTE_LIMIT', DEFAULT_DAILY_BYTES);
	const concurrencyLimit = intEnv('ARCHIVE_CONCURRENT_STREAM_LIMIT', DEFAULT_CONCURRENT_STREAMS);
	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	return db.transaction(async (tx) => {
		await tx.delete(archiveStreamLeases).where(lt(archiveStreamLeases.expiresAt, now));
		const [{ count }] = await tx
			.select({ count: sql<number>`count(*)` })
			.from(archiveStreamLeases)
			.where(eq(archiveStreamLeases.userId, principal.userId));
		if (Number(count) >= concurrencyLimit) throw new ArchiveHttpError(429, 'concurrent stream limit reached');
		const [usage] = await tx
			.select()
			.from(archiveStreamDailyUsage)
			.where(and(eq(archiveStreamDailyUsage.userId, principal.userId), eq(archiveStreamDailyUsage.day, day)))
			.limit(1);
		if ((usage?.bytesReserved ?? 0) + bytes > dailyLimit) throw new ArchiveHttpError(429, 'daily byte budget exceeded');
		if (usage) {
			await tx
				.update(archiveStreamDailyUsage)
				.set({ bytesReserved: usage.bytesReserved + bytes, updatedAt: now })
				.where(and(eq(archiveStreamDailyUsage.userId, principal.userId), eq(archiveStreamDailyUsage.day, day)));
		} else {
			await tx.insert(archiveStreamDailyUsage).values({
				userId: principal.userId,
				day,
				bytesReserved: bytes,
				updatedAt: now
			});
		}
		const leaseId = uuid();
		await tx.insert(archiveStreamLeases).values({
			id: leaseId,
			userId: principal.userId,
			revisionId,
			expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
			createdAt: now
		});
		return leaseId;
	});
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
