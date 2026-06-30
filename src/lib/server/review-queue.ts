/**
 * Read model for the `/admin/review` moderator surface (Git-in-the-DB Phase 5).
 *
 * Two bounded queries, NO per-row fan-out (the `__data.json` fan-out is exactly
 * what hung `/history`, per db/index.ts):
 *
 *   • {@link getReviewQueue}          — the DB-PR queue: every open / needs_evidence
 *     / approved change request joined to its `proposal` diff, newest first, capped.
 *   • {@link getChangeRequestDetail}  — one change request with its before→after
 *     diff, the reviewed observation's evidence/raw payload, the source's CURRENT
 *     field provenance (is the proposal better-sourced than what's there?), and the
 *     append-only prior reviews.
 *
 * Both take an explicit `Db` (matching the merge engine convention) so they are
 * directly unit-testable against an in-memory libSQL — no module singleton.
 * They are PURE READS: nothing here mutates canonical data or workflow state.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
	changeRequests,
	changeRequestReviews,
	sourceObservations,
	sourceObservationDiffs,
	sourceFieldProvenance,
	sourceFieldClaims
} from './db/schema';
import type { Db } from './merge/types';
import type { SourceDiff } from './merge/diff';

/** CR workflow states a moderator still acts on (decided/applied CRs leave the queue). */
export const QUEUE_STATUSES = ['open', 'needs_evidence', 'approved'] as const;
/** Match the spec §6 cap; the queue is a working set, not an archive. */
export const QUEUE_LIMIT = 100;

const toMs = (v: Date | number): number => (v instanceof Date ? v.getTime() : Number(v));

export interface ReviewQueueItem {
	id: string;
	status: string;
	kind: string;
	title: string | null;
	summary: string | null;
	routingReason: string;
	origin: string;
	derivation: string;
	confidence: number;
	createdAt: number;
	sourceId: string | null;
	diff: SourceDiff;
}

/**
 * The DB-PR queue (spec §6): ONE query — change_requests INNER JOIN the 'proposal'
 * diff, status in {open, needs_evidence, approved}, newest first, capped at
 * {@link QUEUE_LIMIT}. The INNER JOIN is total: `openChangeRequest` always writes a
 * `proposal` diff alongside the CR, so every queued CR has exactly one.
 */
export async function getReviewQueue(db: Db): Promise<ReviewQueueItem[]> {
	const rows = await db
		.select({
			id: changeRequests.id,
			status: changeRequests.status,
			kind: changeRequests.kind,
			title: changeRequests.title,
			summary: changeRequests.summary,
			routingReason: changeRequests.routingReason,
			origin: changeRequests.origin,
			derivation: changeRequests.derivation,
			confidence: changeRequests.confidence,
			createdAt: changeRequests.createdAt,
			sourceId: changeRequests.sourceId,
			diff: sourceObservationDiffs.diff
		})
		.from(changeRequests)
		.innerJoin(
			sourceObservationDiffs,
			and(
				eq(sourceObservationDiffs.observationId, changeRequests.observationId),
				eq(sourceObservationDiffs.diffKind, 'proposal')
			)
		)
		.where(inArray(changeRequests.status, [...QUEUE_STATUSES]))
		.orderBy(desc(changeRequests.createdAt))
		.limit(QUEUE_LIMIT);

	return rows.map((r) => ({ ...r, createdAt: toMs(r.createdAt) }));
}

export interface ChangeRequestRow {
	id: string;
	observationId: string;
	sourceId: string | null;
	plannedSourceId: string | null;
	plannedSlug: string | null;
	kind: string;
	status: string;
	routingReason: string;
	title: string | null;
	summary: string | null;
	origin: string;
	originRecordId: string;
	derivation: string;
	confidence: number;
	evidence: number;
	proposedByActor: string | null;
	decidedByActor: string | null;
	decidedAt: number | null;
	appliedObservationStatus: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface CurrentProvenanceRow {
	fieldName: string;
	currentValue: unknown;
	origin: string | null;
	derivation: string | null;
	confidence: number | null;
	evidence: number | null;
	rankBand: number | null;
	rankScore: number | null;
}

export interface ReviewRow {
	id: string;
	reviewerKind: string;
	reviewerActor: string | null;
	verdict: string;
	confidence: number | null;
	reason: string;
	evidenceRefs: string[] | null;
	createdAt: number;
}

export interface ChangeRequestDetail {
	changeRequest: ChangeRequestRow;
	diff: SourceDiff | null;
	observation: {
		payload: Record<string, unknown> | null;
		rawPayload: Record<string, unknown> | null;
		contentHash: string;
		matchDecision: string | null;
		status: string;
	} | null;
	/** the attached source's CURRENT winning provenance per field (empty for a new source) */
	currentProvenance: CurrentProvenanceRow[];
	/** append-only prior reviews (oldest → newest) — shown, never hidden */
	reviews: ReviewRow[];
}

/**
 * One change request with everything a moderator needs to decide: the stored
 * before→after `proposal` diff, the reviewed observation's payload / raw evidence /
 * content hash / match decision, the attached source's current field provenance,
 * and every prior review. Returns `null` when the id is unknown.
 */
export async function getChangeRequestDetail(
	db: Db,
	id: string
): Promise<ChangeRequestDetail | null> {
	const [cr] = await db
		.select()
		.from(changeRequests)
		.where(eq(changeRequests.id, id))
		.limit(1);
	if (!cr) return null;

	const [diffRows, obsRows, reviewRows] = await db.batch([
		db
			.select({ diff: sourceObservationDiffs.diff })
			.from(sourceObservationDiffs)
			.where(
				and(
					eq(sourceObservationDiffs.observationId, cr.observationId),
					eq(sourceObservationDiffs.diffKind, 'proposal')
				)
			)
			.limit(1),
		db
			.select({
				payload: sourceObservations.payload,
				rawPayload: sourceObservations.rawPayload,
				contentHash: sourceObservations.contentHash,
				matchDecision: sourceObservations.matchDecision,
				status: sourceObservations.status
			})
			.from(sourceObservations)
			.where(eq(sourceObservations.id, cr.observationId))
			.limit(1),
		db
			.select({
				id: changeRequestReviews.id,
				reviewerKind: changeRequestReviews.reviewerKind,
				reviewerActor: changeRequestReviews.reviewerActor,
				verdict: changeRequestReviews.verdict,
				confidence: changeRequestReviews.confidence,
				reason: changeRequestReviews.reason,
				evidenceRefs: changeRequestReviews.evidenceRefs,
				createdAt: changeRequestReviews.createdAt
			})
			.from(changeRequestReviews)
			.where(eq(changeRequestReviews.changeRequestId, id))
			.orderBy(asc(changeRequestReviews.createdAt))
	]);

	// Current provenance only exists for an ATTACH proposal (a new source has none).
	let currentProvenance: CurrentProvenanceRow[] = [];
	if (cr.sourceId) {
		const provRows = await db
			.select({
				fieldName: sourceFieldProvenance.fieldName,
				currentValue: sourceFieldClaims.value,
				origin: sourceFieldProvenance.origin,
				derivation: sourceFieldProvenance.derivation,
				confidence: sourceFieldProvenance.confidence,
				evidence: sourceFieldProvenance.evidence,
				rankBand: sourceFieldProvenance.rankBand,
				rankScore: sourceFieldProvenance.rankScore
			})
			.from(sourceFieldProvenance)
			.leftJoin(
				sourceFieldClaims,
				eq(sourceFieldProvenance.currentClaimId, sourceFieldClaims.id)
			)
			.where(eq(sourceFieldProvenance.sourceId, cr.sourceId))
			.orderBy(asc(sourceFieldProvenance.fieldName));
		currentProvenance = provRows;
	}

	return {
		changeRequest: {
			id: cr.id,
			observationId: cr.observationId,
			sourceId: cr.sourceId,
			plannedSourceId: cr.plannedSourceId,
			plannedSlug: cr.plannedSlug,
			kind: cr.kind,
			status: cr.status,
			routingReason: cr.routingReason,
			title: cr.title,
			summary: cr.summary,
			origin: cr.origin,
			originRecordId: cr.originRecordId,
			derivation: cr.derivation,
			confidence: cr.confidence,
			evidence: cr.evidence,
			proposedByActor: cr.proposedByActor,
			decidedByActor: cr.decidedByActor,
			decidedAt: cr.decidedAt ? toMs(cr.decidedAt) : null,
			appliedObservationStatus: cr.appliedObservationStatus,
			createdAt: toMs(cr.createdAt),
			updatedAt: toMs(cr.updatedAt)
		},
		diff: diffRows[0]?.diff ?? null,
		observation: obsRows[0]
			? {
					payload: obsRows[0].payload,
					rawPayload: obsRows[0].rawPayload,
					contentHash: obsRows[0].contentHash,
					matchDecision: obsRows[0].matchDecision,
					status: obsRows[0].status
				}
			: null,
		currentProvenance,
		reviews: reviewRows.map((r) => ({ ...r, createdAt: toMs(r.createdAt) }))
	};
}
