/**
 * Observation diffs — the "commit diff" of the Git-in-the-DB model (Phase 1).
 *
 * Every commit (a `source_observations` row) gets at most one stored diff per
 * kind (`applied` for an auto-applied merge; `proposal`/`planned` reserved for
 * the later PR phases). A diff is a PURE, DB-agnostic before→after view of one
 * source's canonical projection, computed with the SAME `golden.ts` projector +
 * hash the merge engine uses — so the diff and the content hash can never drift.
 *
 * THIS FILE (Phase 1): the stored `SourceDiff` shape contract. The pure diff
 * computation (`diffSourceProjection`) and the one DB read helper
 * (`loadSourceProjection`) are added in the diff-computation module step.
 */
import type { SourceProjection } from '../golden';
import type { ClaimOutcome, ConflictOutcome } from './types';

/** Projected collection element shapes — reuse golden's projection contract. */
export type LinkProj = SourceProjection['links'][number];
export type PersonAssocProj = SourceProjection['persons'][number];
export type PlaceAssocProj = SourceProjection['places'][number];
export type InstAssocProj = SourceProjection['institutions'][number];
export type RelationProj = SourceProjection['relations'][number];

export type CollectionName =
	| 'links'
	| 'tags'
	| 'persons'
	| 'places'
	| 'institutions'
	| 'relations';

export interface ScalarFieldDiff {
	field: string;
	before: unknown;
	after: unknown;
	op: 'add' | 'update' | 'clear';
	/** in the applied diff every shown scalar is 'applied'; the held/rejected ones
	 *  surface separately so a refused edit is visible, never silently dropped. */
	decision?: 'will_apply' | 'applied' | 'held_below' | 'conflict' | 'rejected' | 'noop';
	reason?: string;
}

export interface CollectionDiff<T> {
	added: T[];
	removed: T[];
	updated: Array<{ key: string; before: T; after: T }>;
}

export interface LifecycleDiff {
	eventType: string;
	fromStatus?: string | null;
	toStatus?: string | null;
	reason?: string | null;
}

export interface SourceDiff {
	version: 1;
	sourceId: string | null;
	slug: string | null;
	isNewSource: boolean;
	base: { contentHash: string | null };
	result: { contentHash: string };
	/** user-facing changed scalar columns */
	scalars: ScalarFieldDiff[];
	/** id / createdAt / updatedAt / createdBy / updatedBy — collapsed in the UI */
	systemScalars: ScalarFieldDiff[];
	links: CollectionDiff<LinkProj>;
	tags: CollectionDiff<string>;
	persons: CollectionDiff<PersonAssocProj>;
	places: CollectionDiff<PlaceAssocProj>;
	institutions: CollectionDiff<InstAssocProj>;
	relations: CollectionDiff<RelationProj>;
	lifecycle: LifecycleDiff[];
	changedScalarFields: string[];
	changedCollections: CollectionName[];
	/** e.g. 'yearStart: 1875 → 1872' */
	summaryLines: string[];
	warnings: string[];
	conflicts: ConflictOutcome[];
	/** engine REFUSED these — shown, never silently dropped (no-loss) */
	heldClaims: ClaimOutcome[];
	rejectedClaims: ClaimOutcome[];
}
