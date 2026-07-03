/**
 * Public input/output contract for the merge engine.
 */
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import type * as schema from '../db/schema';
import type { GateDecision } from './decision';

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
	/**
	 * Explicit slug for a source this observation CREATES — wins over title
	 * derivation. The caller MUST pre-validate it (shape + not taken by a source
	 * or a `slug_redirects.old_slug` — see `explicitSlugError`); the engine uses
	 * it verbatim and the UNIQUE constraint on `sources.slug` is the last-resort
	 * guard. Ignored when the observation attaches to an existing source or
	 * materializes a candidate (candidate slugs stay machine-prefixed).
	 */
	slug?: string;
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
	/**
	 * The change-gate verdict the engine COMPUTED for this observation. Surfaced
	 * for observability. When `SOURCES_ENABLE_PROPOSE` is on, a `propose` verdict
	 * is routed to {@link ProposedMergeResult} instead of committing; otherwise it
	 * still falls back to auto-apply. Absent only on results produced outside
	 * `mergeSourceObservation`.
	 */
	gate?: GateDecision;
}

/**
 * The result of routing an observation to the change-request (PR) queue instead
 * of committing it (Git-in-the-DB Phase 3). A proposal writes ONLY three rows —
 * the `proposed` observation, its `proposal` diff, and the `change_requests`
 * envelope — and ZERO canonical data (no `sources` / claim / provenance / link
 * write happens until the CR is APPLIED in Phase 4).
 *
 * It carries the same `appliedClaims` / `heldClaims` / `rejectedClaims` /
 * `conflicts` / `lifecycleEvents` / `gate` shape as {@link MergeResult} so the
 * `MergeResult | ProposedMergeResult` union is ergonomic for callers; on a
 * proposal `appliedClaims` and `lifecycleEvents` are ALWAYS empty (nothing was
 * applied) and `heldClaims` / `rejectedClaims` / `conflicts` carry the dry-run
 * preview from the plan. `changeRequestId` / `diffId` are the propose-only
 * discriminating fields.
 */
export interface ProposedMergeResult {
	status: 'proposed';
	observationId: string;
	/** the opened (or, for a duplicate proposal, the existing) change request */
	changeRequestId: string;
	/** the `proposal` diff row id (empty string when returning an existing dup CR) */
	diffId: string;
	/** the canonical source this proposal would attach to (absent for a new source) */
	sourceId?: string;
	/** the propose gate verdict (mode is always 'propose') */
	gate?: GateDecision;
	/** ALWAYS empty — a proposal applies nothing to canonical data (uniform union shape) */
	appliedClaims: ClaimOutcome[];
	heldClaims: ClaimOutcome[];
	rejectedClaims: ClaimOutcome[];
	conflicts: ConflictOutcome[];
	/** ALWAYS empty — a proposal writes no lifecycle event (uniform union shape) */
	lifecycleEvents: LifecycleOutcome[];
}

/**
 * A review verdict appended to a change request (Git-in-the-DB Phase 4). Reviews
 * are append-only: every verdict — LLM, human, or system — is recorded as one
 * immutable `change_request_reviews` row, then the CR's mutable workflow status is
 * advanced. A reviewer NEVER changes a claim's band / score / rank (those are
 * actor-agnostic and owned by `rank.ts`); a verdict only GATES whether an already
 * band-ranked observation may enter the merge.
 */
export interface ReviewInput {
	/** who is reviewing: an LLM (advisory by default), a human, or the system */
	reviewerKind: 'llm' | 'human' | 'system';
	/** model id / user id — audit-only, NEVER precedence */
	reviewerActor?: string | null;
	verdict: 'apply' | 'reject' | 'needs_evidence';
	reason: string;
	/** LLM self-report in [0,1] — advisory only */
	confidence?: number | null;
	evidenceRefs?: string[];
	/** the raw validated reviewer response — ALWAYS an object, never a bare string */
	payload?: Record<string, unknown>;
}

/**
 * The result of {@link reviewChangeRequest}: the change request's resulting
 * workflow status after the verdict was recorded and acted on.
 *
 *   - `needs_evidence` — the CR was sent back for more evidence;
 *   - `rejected`       — the CR (and its observation) were rejected;
 *   - `approved`       — an LLM `apply` verdict was recorded as ADVISORY (no
 *                        canonical write); a human must still apply;
 *   - `applied`        — a human `apply` (or LLM auto-approve) drove the merge;
 *                        `applied` carries the {@link MergeResult}.
 */
export interface ReviewResult {
	status: 'needs_evidence' | 'rejected' | 'approved' | 'applied';
	/** the appended `change_request_reviews` row id */
	reviewId: string;
	changeRequestId: string;
	/** present only when the verdict triggered an apply (human apply / LLM auto-approve) */
	applied?: MergeResult;
}
