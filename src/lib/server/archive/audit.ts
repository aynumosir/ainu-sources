import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { sourceLifecycleEvents, type SourceLifecycleEvent } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import type { ArchiveEventEntityType } from './types';

type Db = LibSQLDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

export type ArchiveEventType =
	| 'stream_opened'
	| 'upload_created'
	| 'upload_completed'
	| 'upload_verified'
	| 'upload_quarantined'
	| 'upload_aborted'
	| 'revision_approved'
	| 'revision_rejected'
	| 'revision_withdrawn'
	| 'capability_issued'
	| 'capability_redeemed'
	| 'membership_deactivated';

export type ArchiveAuditInput = {
	entityType: ArchiveEventEntityType;
	entityId: string;
	eventType: ArchiveEventType;
	actor: string;
	details?: Record<string, unknown>;
};

const SECRETISH = /token|secret|assertion|signature|signed|bearer|authorization/i;

function sanitize(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!details) return undefined;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(details)) {
		if (SECRETISH.test(key)) continue;
		out[key] = value;
	}
	return out;
}

export async function recordArchiveEvent(db: Conn, input: ArchiveAuditInput): Promise<SourceLifecycleEvent> {
	const [row] = await db
		.insert(sourceLifecycleEvents)
		.values({
			eventType: input.eventType,
			entityType: input.entityType,
			entityId: input.entityId,
			actor: input.actor,
			details: sanitize(input.details)
		})
		.returning();
	return row;
}
