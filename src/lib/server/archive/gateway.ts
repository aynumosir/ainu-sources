import { eq, sql, type SQL } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { env } from '$env/dynamic/private';
import { appUserRoles } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { recordArchiveEvent } from './audit';
import {
	getRevisionForContent,
	reserveContentApiRate,
	reserveStreamQuota,
	type ArchiveBudgetKind
} from './db';
import { ArchiveHttpError } from './errors';
import { buildRangeResponse, quotedSha256Etag } from './range';
import { archiveRoleAtLeast, isArchiveRole, type ArchivePrincipal } from './types';

type Db = LibSQLDatabase<typeof schema>;
type RevisionForContent = Awaited<ReturnType<typeof getRevisionForContent>>;

export type ArchiveContentUseKind =
	| 'original'
	| 'linearized'
	| 'page_image'
	| 'text'
	| 'export'
	| 'search'
	| 'capability'
	| 'mcp_text'
	| 'mcp_image';

export type ArchiveCachePolicy = { cacheControl?: string };

export type AuthorizeContentInput = {
	principal: ArchivePrincipal;
	revisionId?: string | null;
	useKind: ArchiveContentUseKind;
	requestedBytes?: number;
	rangeHeader?: string | null;
	ifRangeHeader?: string | null;
	rateUnits?: number;
};

export type AuthorizeContentResult = {
	revision: RevisionForContent;
	source: {
		id: string;
		slug: string;
		title: string;
		humanDownload: boolean;
	};
	decision: 'allow';
	quota: { reserved: number; remaining: number; resetAt: string; budgetKind: ArchiveBudgetKind };
	auditId: string;
	cachePolicy: ArchiveCachePolicy;
};

const VIEW_USE_KINDS = new Set<ArchiveContentUseKind>([
	'page_image',
	'linearized',
	'text',
	'search',
	'mcp_text',
	'mcp_image'
]);
const PAGE_IMAGE_ESTIMATE_BYTES = 1024 * 1024;
const DOWNLOAD_RIGHT_USE_KINDS = new Set<ArchiveContentUseKind>(['original', 'export', 'capability']);
const SEARCH_REVISION = {
	id: 'archive-search',
	sourceFileId: 'archive-search',
	sourceSlug: 'archive-search',
	sourceId: 'archive-search',
	title: 'Archive search',
	role: 'search',
	checkoutPath: null,
	revisionNo: 0,
	sha256: null,
	bytes: 0,
	declaredMediaType: 'application/json',
	detectedMediaType: 'application/json',
	originalFilename: 'archive-search.json',
	pageCount: null,
	reviewStatus: 'approved',
	accessState: 'available',
	isCurrent: true,
	submittedBy: 'archive-search',
	submittedAt: null,
	reviewedBy: null,
	reviewedAt: null,
	reviewNote: null,
	humanDownload: true
} as RevisionForContent;

function intEnv(name: string): number {
	const value = Number(env[name]);
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function budgetKindFor(useKind: ArchiveContentUseKind): ArchiveBudgetKind {
	return VIEW_USE_KINDS.has(useKind) ? 'view' : 'download';
}

function requiresDownloadRight(useKind: ArchiveContentUseKind): boolean {
	return DOWNLOAD_RIGHT_USE_KINDS.has(useKind);
}

/**
 * Visibility predicate for the `fr` file-revision and `src` source aliases used
 * by archive search. Keeping it here makes ranked SQL and direct content reads
 * apply the same review, current-revision, access-state, and representation rules.
 */
export function archiveSearchVisibilitySql(principal: ArchivePrincipal): SQL {
	const reviewer = archiveRoleAtLeast(principal.role, 'archive_reviewer');
	const review = reviewer
		? sql`1 = 1`
		: principal.role === 'archive_contributor'
			? sql`(fr.review_status = 'approved' or (fr.review_status = 'pending' and fr.submitted_by = ${principal.userId}))`
			: sql`fr.review_status = 'approved'`;
	const current = reviewer ? sql`1 = 1` : sql`fr.is_current = 1`;
	const access =
		principal.role === 'archive_admin'
			? sql`1 = 1`
			: reviewer
				? sql`fr.access_state <> 'takedown'`
				: sql`fr.access_state = 'available'`;
	return sql`(${review}) and (${current}) and (${access})`;
}

function cachePolicyFor(useKind: ArchiveContentUseKind): ArchiveCachePolicy {
	if (useKind === 'page_image') return { cacheControl: 'private, max-age=300, must-revalidate' };
	if (useKind === 'original' || useKind === 'linearized' || useKind === 'capability') {
		return { cacheControl: 'private, no-store' };
	}
	return {};
}

function requestedBytesFor(input: AuthorizeContentInput, revision: RevisionForContent | null): number {
	if (typeof input.requestedBytes === 'number') return Math.max(input.requestedBytes, 0);
	if (input.useKind === 'page_image') {
		// Derivative sizes are only known after the dataplane response. A 1 MiB reservation is a stable estimate for page reads.
		return PAGE_IMAGE_ESTIMATE_BYTES;
	}
	if ((input.useKind === 'original' || input.useKind === 'linearized' || input.useKind === 'capability') && revision) {
		const range = buildRangeResponse(
			input.rangeHeader ?? null,
			input.ifRangeHeader ?? null,
			revision.bytes,
			quotedSha256Etag(revision.sha256 ?? '')
		);
		return range.status === 416 ? 0 : range.contentLength;
	}
	return 0;
}

async function audit(
	db: Db,
	input: AuthorizeContentInput,
	decision: 'allow' | 'deny',
	details: Record<string, unknown> = {}
) {
	return recordArchiveEvent(db, {
		entityType: input.revisionId ? 'file_revision' : 'user',
		entityId: input.revisionId ?? input.principal.userId,
		eventType: decision === 'allow' ? 'content_access_authorized' : 'content_access_denied',
		actor: input.principal.userId,
		details: { use_kind: input.useKind, ...details }
	});
}

async function deny(db: Db, input: AuthorizeContentInput, error: ArchiveHttpError): Promise<never> {
	const row = await audit(db, input, 'deny', { status: error.status, message: error.message });
	throw new ArchiveHttpError(error.status, error.message, { ...error.details, auditId: row.id });
}

async function checkFreshMembership(db: Db, principal: ArchivePrincipal): Promise<void> {
	if (principal.authn !== 'app_session') return;
	const [row] = await db.select().from(appUserRoles).where(eq(appUserRoles.userId, principal.userId)).limit(1);
	if (!isArchiveRole(row?.role) || row.role !== principal.role) {
		throw new ArchiveHttpError(403, 'archive membership changed');
	}
	const staleMs = intEnv('ARCHIVE_MEMBERSHIP_STALE_MS');
	if (staleMs === 0) return;
	// A scheduled reconciliation job is the long-term D19 control. This request gate is an opt-in stopgap while ops tunes staleness windows.
	if (Date.now() - row.updatedAt.getTime() > staleMs) throw new ArchiveHttpError(403, 'archive membership is stale');
}

export async function authorizeContent(db: Db, input: AuthorizeContentInput): Promise<AuthorizeContentResult> {
	let revision: RevisionForContent | null = null;
	try {
		await checkFreshMembership(db, input.principal);
		if (input.revisionId) {
			revision = await getRevisionForContent(db, input.revisionId, input.principal, {
				requireDownloadRight: requiresDownloadRight(input.useKind)
			});
		}
		const requestedBytes = requestedBytesFor(input, revision);
		if (input.useKind === 'text' || input.useKind === 'mcp_text') {
			await reserveContentApiRate(db, input.principal, 'text', input.rateUnits ?? 0);
		}
		if (input.useKind === 'search') {
			await reserveContentApiRate(db, input.principal, 'search', input.rateUnits ?? 0);
		}
		const quota = await reserveStreamQuota(
			db,
			input.principal,
			input.revisionId ?? 'archive-search',
			requestedBytes,
			budgetKindFor(input.useKind)
		);
		const auditRow = await audit(db, input, 'allow', {
			bytes: requestedBytes,
			budget_kind: quota.budgetKind,
			remaining: quota.remaining
		});
		return {
			revision: revision ?? SEARCH_REVISION,
			source: revision
				? {
						id: revision.sourceId,
						slug: revision.sourceSlug,
						title: revision.title,
						humanDownload: revision.humanDownload
					}
				: ({ id: 'archive-search', slug: 'archive-search', title: 'Archive search', humanDownload: true } as AuthorizeContentResult['source']),
			decision: 'allow',
			quota: {
				reserved: quota.reserved,
				remaining: quota.remaining,
				resetAt: quota.resetAt,
				budgetKind: quota.budgetKind
			},
			auditId: auditRow.id,
			cachePolicy: cachePolicyFor(input.useKind)
		};
	} catch (e) {
		if (e instanceof ArchiveHttpError) return deny(db, input, e);
		throw e;
	}
}
