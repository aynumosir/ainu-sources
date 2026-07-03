/**
 * The change-gate decision (Git-in-the-DB §1).
 *
 *   decideChangeGate(plan): GateDecision
 *
 * A PURE predicate over a {@link MergePlan} — derivation / origin /
 * matchDecision / identity-action / conflict / confidence → one of
 * `{ auto_apply | propose | reject }`. It keys ONLY on the observation's
 * derivation, the identity match, and predicted conflicts — NEVER on the actor —
 * so it composes cleanly with the actor-agnostic `rank.ts`: an approval never
 * confers authority, it only decides WHEN an observation may enter the merge.
 *
 * PHASE 2 NOTE: the gate is COMPUTED and surfaced on the `MergeResult`, but it is
 * NOT yet routed. The public entry still commits every non-reject path (the
 * `propose` outcome falls back to auto-apply). Phase 3 wires `propose` to
 * `openChangeRequest` once the `change_requests` table exists.
 */
import { EDITORIAL_ORIGINS } from './constants';
import type { MergeInput, ClaimOutcome, ConflictOutcome } from './types';
import type { IdentityDecision } from './identity';
import type { AuditFinding } from './audit-gate';
import type { NormalizedIdentifier } from './normalize';
import type { PartitionedLinks } from './url-allow';
import type { SourceProjection } from '../golden';
import type { SourceDiff } from './diff';

/** The kind of change an observation represents (queue/label only). */
export type ChangeKind =
	| 'field_update'
	| 'new_source'
	| 'enrichment'
	| 'identity_conflict'
	| 'lifecycle'
	| 'drift';

export type GateMode = 'auto_apply' | 'propose' | 'reject';

export interface GateDecision {
	mode: GateMode;
	reason: string;
	kind: ChangeKind;
}

/** A simulated per-field outcome (the proposal dry-run; Phase-3 facing). */
export interface PlannedFieldOutcome {
	field: string;
	op: string;
	status: 'will_apply' | 'held_below' | 'conflict' | 'rejected' | 'noop';
	before: unknown;
	after: unknown;
	band: number;
	score: number;
	reason?: string;
}

/**
 * The pure-reads result of {@link planSourceObservation}. It carries everything
 * the writer ({@link commitMerge}) needs — the normalized payload, the dedupe
 * probe, the audit findings and the identity decision — plus the computed
 * {@link GateDecision}. The *simulation* fields (before/after projection,
 * predicted outcomes, proposal diff) are populated only when the plan is asked
 * to simulate (`opts.simulate`); on the commit path they stay empty/null, so the
 * auto-apply composition adds ZERO round-trips over the pre-refactor engine.
 */
export interface MergePlan {
	input: MergeInput;

	// ── normalized inputs (pure) ──────────────────────────────────────────────
	normIds: NormalizedIdentifier[];
	cleanFields: Record<string, unknown>;
	safeLinks: PartitionedLinks['safe'];
	unsafeLinks: PartitionedLinks['unsafe'];
	payload: Record<string, unknown>;
	contentHash: string;

	// ── pure-read probes ──────────────────────────────────────────────────────
	/** an already-recorded observation with the same (origin, recordId, hash) */
	duplicate?: { id: string; status: string };
	audit: { fatal: AuditFinding[]; llm: { rejectedFields: string[]; rejectStrongIds: boolean } };
	identity: IdentityDecision;

	// ── simulation (opt-in; Phase-3 proposal diff) ────────────────────────────
	beforeProjection: SourceProjection | null;
	afterProjection: SourceProjection | null;
	baseContentHash: string | null;
	resultContentHash: string | null;
	predictedFieldOutcomes: PlannedFieldOutcome[];
	predictedConflicts: ConflictOutcome[];
	/** identifier / identity conflicts surfaced pre-write */
	conflicts: ConflictOutcome[];
	heldClaims: ClaimOutcome[];
	rejectedClaims: ClaimOutcome[];
	diff: SourceDiff | null;

	// ── the gate (computed last, over everything above) ───────────────────────
	gate: GateDecision;
}

/** matchDecision values that mean "we are confident this attaches to THIS source".
 *  Exported so the Phase-6 LLM reviewer can reuse the SAME "clean attach" definition
 *  in its safe-enrichment auto-approve predicate (identity, never precedence). */
export const STRONG_ATTACH = new Set([
	'explicit_target', // website edit names the id
	'strong_single', // single strong identifier hit
	'repo_path_exact', // exact legacy repo_path hit
	'repo_path_rename_rebind' // substantive-field hash rebind
]);

/** derivations trusted enough to auto-apply (never the low-trust tier). */
const AUTO_TRUST = new Set([
	'editorial_decision',
	'curated_assertion',
	'observed',
	'transcribed',
	'extracted',
	'normalized'
]);

/** low-trust derivations that NEVER auto-apply, even when they attach cleanly. */
const LOW_TRUST = new Set(['llm_extraction', 'inferred', 'heuristic']);

/**
 * Decide whether an observation may auto-apply, must be proposed for review, or
 * is rejected outright. PURE — no DB, no side effects.
 */
export function decideChangeGate(plan: MergePlan): GateDecision {
	const i = plan.input;
	const id = plan.identity;

	// 0. fatal audit ⇒ never a PR. The observation is still recorded (no-loss); it
	//    just never touches canonical data.
	if (plan.audit.fatal.length)
		return {
			mode: 'reject',
			reason: plan.audit.fatal.map((f) => f.reason).join(';'),
			kind: 'field_update'
		};

	// 1. upstream disappearance ⇒ drift only, never delete. Auto-record iff attached.
	if (i.presence === 'missing')
		return id.action === 'attach'
			? { mode: 'auto_apply', reason: 'drift', kind: 'drift' }
			: { mode: 'reject', reason: 'missing_unknown', kind: 'drift' };

	// 2. lifecycle (soft_delete/hide/restore/deprecate) is destructive intent ⇒
	//    only a deterministic editorial op on a known source auto-applies.
	if (i.lifecycle)
		return id.action === 'attach' &&
			i.derivation === 'editorial_decision' &&
			EDITORIAL_ORIGINS.has(i.origin)
			? { mode: 'auto_apply', reason: 'editorial_lifecycle', kind: 'lifecycle' }
			: { mode: 'propose', reason: 'lifecycle_review', kind: 'lifecycle' };

	// 3. brand-NEW source (create/candidate) OR strong-id pointing at MANY sources
	//    ⇒ always a PR (new additions are reviewed).
	if (id.action !== 'attach')
		return {
			mode: 'propose',
			reason: `new_or_unresolved:${id.matchDecision}`,
			kind: id.action === 'conflict' ? 'identity_conflict' : 'new_source'
		};

	// 4. predicted same-band conflict / identifier conflict ⇒ PR.
	if (plan.conflicts.length || plan.predictedConflicts.length)
		return { mode: 'propose', reason: 'conflict', kind: 'identity_conflict' };

	// 5. low-trust derivations NEVER auto-apply, even when they attach cleanly.
	if (LOW_TRUST.has(i.derivation))
		return { mode: 'propose', reason: `low_trust:${i.derivation}`, kind: 'enrichment' };

	// 6. AUTO-APPLY: editorial edit on a known source.
	if (
		i.derivation === 'editorial_decision' &&
		EDITORIAL_ORIGINS.has(i.origin) &&
		STRONG_ATTACH.has(id.matchDecision) &&
		i.confidence >= 0.99
	)
		return { mode: 'auto_apply', reason: 'editorial_edit', kind: 'field_update' };

	// 7. AUTO-APPLY: trusted harvest with a strong identity match.
	//    A STRONG identifier match is itself high-confidence: the id certainty —
	//    not the field confidence — is what a strong attach turns on, so the gate
	//    keys on the 0.7 bootstrap band (curated_assertion 0.8, observed/extracted
	//    0.7) rather than the 0.85 editorial-adjacent floor. Band precedence in the
	//    writer still protects editorial/curated values from a lower-band harvest
	//    claim, so lowering this threshold cannot clobber curated data — it only
	//    lets trusted enrichments catch up instead of flooding the review queue.
	if (
		id.action === 'attach' &&
		STRONG_ATTACH.has(id.matchDecision) &&
		AUTO_TRUST.has(i.derivation) &&
		i.confidence >= 0.7
	)
		return { mode: 'auto_apply', reason: 'strong_match_harvest', kind: 'field_update' };

	// 8. everything else attaching (medium_corroborated, low confidence, …) ⇒ PR.
	return {
		mode: 'propose',
		reason: `review:${i.derivation}:${id.matchDecision}`,
		kind: 'enrichment'
	};
}
