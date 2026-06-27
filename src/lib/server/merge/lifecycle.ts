/**
 * Lifecycle writes (§2 step 14) — status transitions + soft-merge.
 *
 * NO-LOSS: deletion is a STATUS change recorded as an append-only lifecycle
 * event; the source row (and its links/claims/history) is never removed. A
 * soft-merge keeps the loser with status='merged' + mergedIntoSourceId and an
 * accepted same-work relation to the winner.
 */
import { and, eq } from 'drizzle-orm';
import { sources, sourceLifecycleEvents, sourceRelations } from '../db/schema';
import type { Db, LifecycleOutcome } from './types';

export async function writeLifecycleEvent(
	db: Db,
	e: {
		sourceId: string;
		eventType: string;
		observationId?: string | null;
		fromStatus?: string | null;
		toStatus?: string | null;
		fromMergedInto?: string | null;
		toMergedInto?: string | null;
		reason?: string | null;
		actor?: string | null;
		createdAt?: Date;
	}
): Promise<LifecycleOutcome> {
	await db.insert(sourceLifecycleEvents).values({
		sourceId: e.sourceId,
		observationId: e.observationId ?? null,
		eventType: e.eventType,
		fromStatus: e.fromStatus ?? null,
		toStatus: e.toStatus ?? null,
		fromMergedInto: e.fromMergedInto ?? null,
		toMergedInto: e.toMergedInto ?? null,
		reason: e.reason ?? null,
		actor: e.actor ?? null,
		createdAt: e.createdAt ?? new Date()
	});
	return { eventType: e.eventType, fromStatus: e.fromStatus ?? null, toStatus: e.toStatus ?? null };
}

const LIFECYCLE_TARGET_STATUS: Record<string, string> = {
	soft_delete: 'soft_deleted',
	restore: 'active',
	hide: 'hidden',
	unhide: 'active',
	deprecate: 'deprecated'
};

const LIFECYCLE_EVENT_TYPE: Record<string, string> = {
	soft_delete: 'soft_delete',
	restore: 'restore',
	hide: 'hide',
	unhide: 'unhide',
	deprecate: 'deprecate'
};

/**
 * Apply a deliberate status transition. Updates `sources.status` and records the
 * event. Idempotent: a no-op transition (already at target) still records the
 * event but returns the no-op flag so the caller can label the merge.
 */
export async function applyLifecycleOp(
	db: Db,
	args: {
		sourceId: string;
		op: 'soft_delete' | 'restore' | 'hide' | 'unhide' | 'deprecate';
		observationId?: string | null;
		reason?: string | null;
		actor?: string | null;
	}
): Promise<{ outcome: LifecycleOutcome; changed: boolean }> {
	const toStatus = LIFECYCLE_TARGET_STATUS[args.op];
	const eventType = LIFECYCLE_EVENT_TYPE[args.op];
	const [cur] = await db
		.select({ status: sources.status })
		.from(sources)
		.where(eq(sources.id, args.sourceId))
		.limit(1);
	const fromStatus = cur?.status ?? null;
	const changed = fromStatus !== toStatus;
	if (changed) {
		await db.update(sources).set({ status: toStatus }).where(eq(sources.id, args.sourceId));
	}
	const outcome = await writeLifecycleEvent(db, {
		sourceId: args.sourceId,
		eventType,
		observationId: args.observationId,
		fromStatus,
		toStatus,
		reason: args.reason,
		actor: args.actor
	});
	return { outcome, changed };
}

/**
 * Soft-merge `loserId` into `winnerId`: loser kept (status='merged',
 * mergedIntoSourceId=winner), an accepted same-work relation winner→loser, and
 * a merge lifecycle event. Idempotent.
 */
export async function softMerge(
	db: Db,
	args: {
		loserId: string;
		winnerId: string;
		observationId?: string | null;
		reason?: string | null;
		actor?: string | null;
	}
): Promise<LifecycleOutcome> {
	const [cur] = await db
		.select({ status: sources.status, mergedIntoSourceId: sources.mergedIntoSourceId })
		.from(sources)
		.where(eq(sources.id, args.loserId))
		.limit(1);
	const fromStatus = cur?.status ?? null;
	await db
		.update(sources)
		.set({ status: 'merged', mergedIntoSourceId: args.winnerId })
		.where(eq(sources.id, args.loserId));

	// accepted same-work relation (winner → loser), deduped
	const existingRel = await db
		.select({ id: sourceRelations.id })
		.from(sourceRelations)
		.where(
			and(
				eq(sourceRelations.fromSourceId, args.winnerId),
				eq(sourceRelations.toSourceId, args.loserId),
				eq(sourceRelations.type, 'same-work')
			)
		)
		.limit(1);
	if (!existingRel[0]) {
		await db.insert(sourceRelations).values({
			fromSourceId: args.winnerId,
			toSourceId: args.loserId,
			type: 'same-work',
			status: 'accepted',
			origin: 'merge',
			derivation: 'editorial_decision',
			observationId: args.observationId ?? null
		});
	}

	return writeLifecycleEvent(db, {
		sourceId: args.loserId,
		eventType: 'merge',
		observationId: args.observationId,
		fromStatus,
		toStatus: 'merged',
		toMergedInto: args.winnerId,
		reason: args.reason,
		actor: args.actor
	});
}
