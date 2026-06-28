// ---------------------------------------------------------------------------
// Public visibility predicates (公開可視性) — the status-aware read model.
//
// Sources carry a lifecycle `status` (active | candidate | merged | deprecated
// | hidden | soft_deleted) and relations carry one too (accepted | candidate |
// rejected | removed). The merge engine will start producing non-active rows
// (merge losers, hidden spam, candidates awaiting review). These helpers are the
// SINGLE source of truth for "what the public is allowed to see": every public
// read of `sources` must compose `activeSourcesOnly()`, and every public read of
// a relation must compose `publicRelationsOnly()`.
//
// They are deliberately tiny, composable Drizzle conditions so they drop into an
// existing `and(...)` / `.where(...)` without restructuring a query. On today's
// data (every row status='active' / 'accepted') they are exact no-ops — the
// public site behaves identically — but once lifecycle statuses appear, no
// non-active source or non-accepted relation can leak into any public surface.
// ---------------------------------------------------------------------------
import { eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { sources, sourceRelations } from './db/schema';

/** The only `sources.status` value the public may see. */
export const ACTIVE_SOURCE_STATUS = 'active';
/** The only `source_relations.status` value rendered publicly. */
export const PUBLIC_RELATION_STATUS = 'accepted';

/**
 * Restrict a `sources` read to publicly-visible (active) rows.
 *
 * Pass an explicit status column when filtering the *other* endpoint of a
 * self-join (e.g. the joined-in `sources` row of a relation) — it defaults to
 * `sources.status`, which is correct for any query with a single `sources` join.
 */
export function activeSourcesOnly(col: SQLiteColumn = sources.status): SQL {
	return eq(col, ACTIVE_SOURCE_STATUS);
}

/** Restrict a `source_relations` read to accepted (publicly-displayable) edges. */
export function publicRelationsOnly(col: SQLiteColumn = sourceRelations.status): SQL {
	return eq(col, PUBLIC_RELATION_STATUS);
}
