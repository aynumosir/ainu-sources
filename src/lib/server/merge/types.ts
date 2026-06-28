/**
 * Public input/output contract for the merge engine.
 */
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from '../db/schema';

/** The Drizzle handle the engine operates on (app proxy OR a libSQL file: test DB). */
export type Db = LibSQLDatabase<typeof schema>;

/** A raw identifier carried on an observation, before normalization. */
export interface IdentifierInput {
	/** doi | openalex_work | isbn | issn | cinii | ndl | jstage | repo_path | url_persistent | synthetic_stable */
	kind: string;
	/** raw value as received upstream */
	value: string;
	/** optional override of the kind's default strength */
	strength?: 'strong' | 'medium' | 'weak';
	/** raw value (same kind) this identifier now redirects to — e.g. an OpenAlex
	 *  work merged into a canonical id. Resolves to the canonical's source. */
	redirectsTo?: string;
}

/** A digital-access link carried on an observation (set-union merged, never dropped). */
export interface LinkInput {
	/** iiif | pdf | doi | ndl | cinii | github | website | … (defaults to 'website') */
	type?: string;
	url: string;
	label?: string | null;
}

/** A single deliberate source-lifecycle transition (status change, never a row delete). */
export interface LifecycleInput {
	op: 'soft_delete' | 'restore' | 'hide' | 'unhide' | 'deprecate';
	reason?: string;
}

/** The full observation submitted to `mergeSourceObservation`. */
export interface MergeInput {
	/** harvest/import origin, e.g. 'crossref' | 'website' | 'manual' | 'ndl' | 'feed:conferences' */
	origin: string;
	/** stable upstream record id (NOT NULL); website edits use `website:<sourceId>` */
	originRecordId: string;
	/** observed | curated_assertion | editorial_decision | transcribed | extracted | normalized | llm_extraction | inferred | heuristic */
	derivation: string;
	/** confidence in [0,1] */
	confidence: number;
	/** count of corroborating evidence items (>=0) */
	evidence?: number;
	/** canonical scalar / set fields keyed by `sources` column name */
	fields?: Record<string, unknown>;
	/**
	 * Deterministic identity target. When set, the merge ATTACHES to exactly this
	 * source id (matchDecision='explicit_target') and skips find-or-create entirely
	 * — an editorial EDIT lands on its own source instead of forking on a
	 * substantive field change, and the costly catalogue scan in `resolveIdentity`
	 * is avoided. IDENTITY ONLY: it never influences claim precedence / band-rank
	 * (the website edit still carries its own derivation/confidence for ranking).
	 * The caller MUST guarantee the source exists (the website update path reads it
	 * first); a non-existent id would surface as an FK error on the first child write.
	 */
	targetSourceId?: string;
	identifiers?: IdentifierInput[];
	links?: LinkInput[];
	/** field names to explicitly clear (op='explicit_delete'); lets an empty value
	 *  legitimately overwrite a non-empty one without violating the no-clobber rule */
	explicitDeletes?: string[];
	/** upstream presence: 'missing' records drift only — NEVER mutates the source */
	presence?: 'seen' | 'missing';
	/** a deliberate source-status transition (soft delete / hide / restore / …) */
	lifecycle?: LifecycleInput;
	runId?: string | null;
	/**
	 * Skip the engine's own `source_revisions` write. The website create/update
	 * paths re-stamp (and would otherwise discard) the engine's revision with the
	 * real user + summary immediately after, so writing it twice is pure
	 * round-trip waste against the stateless Worker client. Harvest callers leave
	 * this false so their history is still recorded by the engine.
	 */
	skipRevision?: boolean;
	/** audit-only actor descriptor; NEVER used for precedence */
	actor?: string | null;
	rawPayload?: Record<string, unknown> | null;
	normalizerVersion?: number;
}

/** Per-field outcome of a merge. */
export interface ClaimOutcome {
	fieldName: string;
	op: string;
	status: 'applied' | 'held_below' | 'rejected' | 'conflict' | 'noop';
	valueHash?: string;
	band?: number;
	score?: number;
	reason?: string;
}

/** A detected conflict that left the projection unchanged (held for review). */
export interface ConflictOutcome {
	kind:
		| 'identifier_conflict'
		| 'strong_multi'
		| 'field_conflict'
		| 'candidate_duplicate';
	fieldName?: string;
	detail: string;
	sourceIds?: string[];
}

/** A lifecycle transition written during the merge. */
export interface LifecycleOutcome {
	eventType: string;
	fromStatus?: string | null;
	toStatus?: string | null;
}

/** The single return shape of `mergeSourceObservation`. */
export interface MergeResult {
	observationId: string;
	sourceId?: string;
	status:
		| 'applied'
		| 'partial'
		| 'noop'
		| 'rejected'
		| 'conflict'
		| 'candidate'
		| 'drift';
	appliedClaims: ClaimOutcome[];
	heldClaims: ClaimOutcome[];
	rejectedClaims: ClaimOutcome[];
	conflicts: ConflictOutcome[];
	lifecycleEvents: LifecycleOutcome[];
}
