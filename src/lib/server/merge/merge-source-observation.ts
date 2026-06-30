/**
 * The merge engine entry point (§2).
 *
 *   mergeSourceObservation(db, input): Promise<MergeResult>
 *
 * Pipeline: normalize → contentHash → upsert observed_record + insert
 * observation idempotently (dup ⇒ noop) → URL allowlist → audit gate →
 * identity find-or-create → attach identifiers (conflict ⇒ candidate, never
 * move) → per-field claim + band-rank + CAS apply (equal hash ⇒ noop; lower ⇒
 * held_below; same-band near-score materially different ⇒ conflict) → set-union
 * links → project winners to flat `sources` → source_revisions row → lifecycle.
 *
 * NO-LOSS: observations / claims / lifecycle are append-only; deletion is a
 * status change; upstream disappearance is drift; the engine NEVER hard-deletes.
 *
 * Single statements + CAS only — no interactive transaction (the Worker uses a
 * stateless web libSQL client where tx isolation does not hold).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { slugify } from '$lib/format';
import {
	sources,
	sourceLinks,
	sourceTags,
	tags,
	sourcePersons,
	persons,
	sourcePlaces,
	places,
	sourceInstitutions,
	institutions,
	sourceRelations,
	sourceObservations,
	sourceObservedRecords,
	sourceIdentifiers,
	sourceFieldClaims,
	sourceFieldProvenance,
	sourceLifecycleEvents,
	sourceRevisions,
	sourceObservationDiffs,
	changeRequests
} from '../db/schema';
import { projectSource, hashProjection, type SourceProjection } from '../golden';
import { diffSourceProjection, loadSourceProjection, type SourceDiff } from './diff';
import { decideChangeGate, type MergePlan, type PlannedFieldOutcome } from './decision';
import type {
	Db,
	MergeInput,
	MergeResult,
	ProposedMergeResult,
	ClaimOutcome,
	ConflictOutcome,
	LifecycleOutcome
} from './types';
import type { IdentityDecision } from './identity';
import { NORMALIZER_VERSION } from './constants';
import { hashValue, hashPayload } from './hash';
import {
	normalizeFields,
	normalizeIdentifier,
	isEmptyValue,
	type NormalizedIdentifier
} from './normalize';
import { partitionLinks } from './url-allow';
import { FIELD_POLICIES, ENUMS, CLAIMABLE_FIELDS } from './field-policies';
import {
	rankOf,
	compareRank,
	EDITORIAL_BAND,
	NEAR_SCORE_DELTA,
	normalizeOrigin,
	type Rank
} from './rank';
import { auditIngest, auditCreation, auditLlmAssertions, isEmptyOverwrite } from './audit-gate';
import { resolveIdentity } from './identity';
import {
	readProvenance,
	readAllProvenance,
	casInsertFirst,
	casUpdate,
	CAS_MAX_RETRY,
	type ProvenanceWrite,
	type ProvenanceRow
} from './cas';
import { applyLifecycleOp } from './lifecycle';

const uuid = () => crypto.randomUUID();
const NULL_HASH = hashValue(null);
const CLAIMABLE = new Set(CLAIMABLE_FIELDS);

function rowsAffected(res: unknown): number {
	return (res as { rowsAffected?: number })?.rowsAffected ?? 0;
}

// ---------------------------------------------------------------------------
// Entry point — plan (pure reads) → gate → commit (writes)
// ---------------------------------------------------------------------------

/**
 * The public idempotent entry. Splits into a pure-reads {@link planSourceObservation}
 * (which computes the {@link decideChangeGate} verdict) and a writer
 * {@link commitMerge}.
 *
 * PHASE 2 — BEHAVIOR-PRESERVING: the gate is COMPUTED and surfaced on the result,
 * but every non-duplicate path still commits exactly as before. `propose` falls
 * back to auto-apply (see the TODO) because the `change_requests` table does not
 * exist yet; Phase 3 routes it to `openChangeRequest`. Output is byte-identical
 * to the pre-refactor monolith.
 */
export async function mergeSourceObservation(db: Db, input: MergeInput): Promise<MergeResult> {
	const plan = await planSourceObservation(db, input);

	if (plan.gate.mode === 'propose') {
		// TODO(phase3): route to openChangeRequest(db, plan) once `change_requests`
		// exists. Until then a proposed observation AUTO-APPLIES — exactly today's
		// behavior (every observation that reaches the engine is committed).
		return commitMerge(db, plan);
	}
	// 'auto_apply' commits; 'reject' commits too (records the rejected observation
	// in the ledger without mutating canonical data) — both unchanged from before.
	return commitMerge(db, plan);
}

/**
 * The READER half of the engine: normalize + hash the payload, probe for a
 * duplicate observation, run the audit, resolve identity, and compute the
 * {@link decideChangeGate} verdict. PURE READS — no mutation. The composed
 * `mergeSourceObservation` does exactly the dedupe + identity reads the
 * pre-refactor engine did (just earlier), so the writer can reuse them and the
 * round-trip count is unchanged.
 *
 * `opts.simulate` additionally computes the read-only proposal preview
 * (before/after projection, predicted field outcomes, the proposal diff). It is
 * OFF on the commit path — the writer produces its own `applied` diff — so the
 * auto-apply composition adds zero round-trips. Phase-3's propose path sets it.
 */
export async function planSourceObservation(
	db: Db,
	input: MergeInput,
	opts?: { ignoreObservationId?: string; simulate?: boolean }
): Promise<MergePlan> {
	const nv = input.normalizerVersion ?? NORMALIZER_VERSION;
	const origin = input.origin;
	const originRecordId = input.originRecordId;
	const presence = input.presence ?? 'seen';

	// 1. normalize identifiers + fields, partition links by URL allowlist (pure)
	const normIds = (input.identifiers ?? []).map((i) => normalizeIdentifier(i));
	const cleanFields = normalizeFields(input.fields);
	const { safe: safeLinks, unsafe: unsafeLinks } = partitionLinks(input.links);

	// 2. payload hash (idempotency component) (pure)
	const payload: Record<string, unknown> = {
		fields: cleanFields,
		identifiers: normIds.map((i) => ({ kind: i.kind, valueNorm: i.valueNorm })),
		links: safeLinks,
		explicitDeletes: [...(input.explicitDeletes ?? [])].sort(),
		presence,
		lifecycle: input.lifecycle ?? null
	};
	const contentHash = hashPayload(payload);

	// 3. duplicate probe (READ) — same (origin, originRecordId, contentHash) already
	//    recorded. The writer reuses this; it never re-reads. A single-column UNIQUE
	//    index guarantees ≤ 1 row, so `ignoreObservationId` (Phase-4 re-plan) just
	//    drops the change request's own proposed observation.
	const [dupRow] = await db
		.select({ id: sourceObservations.id, status: sourceObservations.status })
		.from(sourceObservations)
		.where(
			and(
				eq(sourceObservations.origin, origin),
				eq(sourceObservations.originRecordId, originRecordId),
				eq(sourceObservations.contentHash, contentHash)
			)
		)
		.limit(1);
	const duplicate = dupRow && dupRow.id !== opts?.ignoreObservationId ? dupRow : undefined;

	// 4. audit gate (pure)
	const fatal = auditIngest({
		origin,
		derivation: input.derivation,
		confidence: input.confidence,
		evidence: input.evidence ?? 0,
		identifiers: normIds,
		fields: cleanFields
	});
	const llm = auditLlmAssertions({
		derivation: input.derivation,
		evidence: input.evidence ?? 0,
		identifiers: normIds,
		fields: cleanFields
	});

	// 5. identity find-or-create (READ; an explicit targetSourceId short-circuits,
	//    pure). SKIPPED for a known duplicate — the pre-refactor engine returned at
	//    the dedupe check BEFORE resolving identity, so resolving it here would add a
	//    read on the idempotent re-submit path. The gate is then irrelevant (commit
	//    noops on the duplicate).
	const identity: IdentityDecision = duplicate
		? {
				action: 'attach',
				status: 'active',
				matchDecision: 'duplicate',
				hasStrongId: false,
				hasTitle: false
			}
		: await resolveIdentity(db, {
				identifiers: normIds,
				fields: cleanFields,
				targetSourceId: input.targetSourceId
			});

	const plan: MergePlan = {
		input,
		normIds,
		cleanFields,
		safeLinks,
		unsafeLinks,
		payload,
		contentHash,
		duplicate,
		audit: { fatal, llm },
		identity,
		beforeProjection: null,
		afterProjection: null,
		baseContentHash: null,
		resultContentHash: null,
		predictedFieldOutcomes: [],
		predictedConflicts: [],
		conflicts: [],
		heldClaims: [],
		rejectedClaims: [],
		diff: null,
		// placeholder; the real verdict is computed once the plan is fully populated
		gate: { mode: 'auto_apply', reason: 'pending', kind: 'field_update' }
	};

	// simulate BEFORE the gate so a predicted same-band conflict feeds the verdict.
	if (opts?.simulate && !duplicate) await simulatePlan(db, plan);
	plan.gate = decideChangeGate(plan);
	return plan;
}

// ---------------------------------------------------------------------------
// Read-only proposal simulation (Phase-3 facing; OFF on the commit path)
// ---------------------------------------------------------------------------

/**
 * Fill a plan's proposal preview WITHOUT writing: the canonical `before`
 * projection, a predicted `after` overlaying only the fields the merge would let
 * win (decided by the SAME `compareRank` / `NEAR_SCORE_DELTA` / `EDITORIAL_BAND`
 * the writer uses — the shared comparator that keeps plan and commit from
 * diverging), and the resulting {@link SourceDiff}. The stored proposal diff is
 * advisory: the Phase-4 apply path re-plans live against current canonical before
 * it commits, so a stale preview can never silently misapply.
 */
async function simulatePlan(db: Db, plan: MergePlan): Promise<void> {
	const { identity, cleanFields, input } = plan;
	const origin = input.origin;
	const derivation = input.derivation;
	const confidence = input.confidence;
	const evidence = input.evidence ?? 0;
	const explicitDeletes = new Set(input.explicitDeletes ?? []);
	const isEditorialObs = derivation === 'editorial_decision';

	// before projection + current provenance winners (attach only).
	let before: SourceProjection | null = null;
	let baseContentHash: string | null = null;
	let provByField = new Map<string, ProvenanceRow>();
	const sourceId = identity.action === 'attach' ? identity.sourceId : undefined;
	if (sourceId) {
		const loaded = await loadSourceProjection(db, sourceId);
		if (loaded) {
			before = loaded.projection;
			baseContentHash = loaded.contentHash;
		}
		provByField = await readAllProvenance(db, sourceId);
	}

	const beforeScalars = (before ?? {}) as Record<string, unknown>;
	const overlay: Record<string, unknown> = {};
	const predicted: PlannedFieldOutcome[] = [];
	const predictedConflicts: ConflictOutcome[] = [];

	const fieldsToProcess = new Set<string>([...Object.keys(cleanFields), ...explicitDeletes]);
	for (const field of fieldsToProcess) {
		if (!CLAIMABLE.has(field)) continue;
		const policy = FIELD_POLICIES[field];
		if (plan.audit.llm.rejectedFields.includes(field)) {
			predicted.push(outcome(field, 'set', 'rejected', beforeScalars[field], beforeScalars[field], 0, 0, 'llm_restricted'));
			continue;
		}
		if (policy.policy === 'editorial_only' && !isEditorialObs) {
			predicted.push(outcome(field, 'set', 'rejected', beforeScalars[field], beforeScalars[field], 0, 0, 'editorial_only_field'));
			continue;
		}
		const isExplicitDelete = explicitDeletes.has(field);
		const value = isExplicitDelete ? null : cleanFields[field];
		if (
			policy.policy === 'controlled_scalar_ranked' &&
			!isExplicitDelete &&
			!isEmptyValue(value) &&
			policy.enum &&
			!policy.enum.has(String(value))
		) {
			predicted.push(outcome(field, 'set', 'rejected', beforeScalars[field], beforeScalars[field], 0, 0, 'invalid_enum'));
			continue;
		}

		const rank = rankOf(field, { derivation, origin, confidence, evidence });
		const prov = provByField.get(field);
		const cur = prov ? { band: prov.rankBand ?? 0, score: prov.rankScore ?? 0 } : null;

		// set_union: additive (editorial replaces). No-loss ⇒ always at least applies.
		if (policy.policy === 'set_union') {
			if (isExplicitDelete || isEmptyValue(value)) continue;
			const incoming = Array.isArray(value) ? (value as string[]) : [];
			const existing = Array.isArray(beforeScalars[field]) ? (beforeScalars[field] as string[]) : [];
			const merged = isEditorialObs
				? [...new Set(incoming)].sort()
				: [...new Set([...existing, ...incoming])].sort();
			const same = JSON.stringify(merged) === JSON.stringify([...existing].sort());
			overlay[field] = merged;
			predicted.push(outcome(field, 'set', same ? 'noop' : 'will_apply', existing, merged, rank.band, rank.score));
			continue;
		}

		const hasExistingNonEmpty = !isEmptyValue(beforeScalars[field]);
		if (!isExplicitDelete && isEmptyValue(value) && hasExistingNonEmpty) {
			predicted.push(outcome(field, 'set', 'rejected', beforeScalars[field], beforeScalars[field], rank.band, rank.score, 'empty_overwrite'));
			continue;
		}
		if (!isExplicitDelete && isEmptyValue(value)) continue;

		const op = isExplicitDelete ? 'explicit_delete' : policy.policy === 'append_or_ranked' ? 'append' : 'set';
		const decided = decidePredicted(rank, cur, isEditorialObs);
		const beforeVal = beforeScalars[field] ?? null;
		const afterVal = isExplicitDelete ? null : value;
		if (decided === 'win') {
			overlay[field] = isExplicitDelete ? null : value;
			predicted.push(outcome(field, op, 'will_apply', beforeVal, afterVal, rank.band, rank.score));
		} else if (decided === 'conflict') {
			predicted.push(outcome(field, op, 'conflict', beforeVal, afterVal, rank.band, rank.score, 'same_band_conflict'));
			predictedConflicts.push({ kind: 'field_conflict', fieldName: field, detail: `same-band conflict on ${field}` });
		} else {
			predicted.push(outcome(field, op, 'held_below', beforeVal, afterVal, rank.band, rank.score, 'held_below'));
		}
	}

	// links: set-union with the existing (never drops). Other collections passthrough.
	const beforeLinks = before?.links ?? [];
	const linkKey = (t: string, u: string) => `${t}\n${u}`;
	const haveLinks = new Set(beforeLinks.map((l) => linkKey(l.type, l.url)));
	const afterLinks = [...beforeLinks];
	let order = beforeLinks.length;
	for (const l of plan.safeLinks) {
		if (haveLinks.has(linkKey(l.type, l.url))) continue;
		afterLinks.push({ type: l.type, url: l.url, label: l.label, sortOrder: order++ });
		haveLinks.add(linkKey(l.type, l.url));
	}

	const after: SourceProjection = before
		? ({ ...(before as Record<string, unknown>), ...overlay, links: afterLinks } as SourceProjection)
		: (projectSource({
				source: { ...overlay, slug: null },
				links: afterLinks,
				tags: [],
				persons: [],
				places: [],
				institutions: [],
				relations: []
			}) as SourceProjection);
	const resultContentHash = hashProjection(after);

	const diff = diffSourceProjection({
		sourceId: sourceId ?? null,
		slug: (after.slug as string | null) ?? null,
		before,
		after,
		beforeHash: baseContentHash,
		afterHash: resultContentHash,
		conflicts: predictedConflicts,
		heldClaims: predicted.filter((o) => o.status === 'held_below').map(toClaim),
		rejectedClaims: predicted.filter((o) => o.status === 'rejected').map(toClaim)
	});

	plan.beforeProjection = before;
	plan.afterProjection = after;
	plan.baseContentHash = baseContentHash;
	plan.resultContentHash = resultContentHash;
	plan.predictedFieldOutcomes = predicted;
	plan.predictedConflicts = predictedConflicts;
	plan.heldClaims = predicted.filter((o) => o.status === 'held_below').map(toClaim);
	plan.rejectedClaims = predicted.filter((o) => o.status === 'rejected').map(toClaim);
	plan.diff = diff;
}

/** The per-field win/hold/conflict decision, mirroring `applyScalarCas`'s
 *  post-read branch (the shared comparator the spec calls the correctness guard). */
function decidePredicted(
	rank: Rank,
	cur: { band: number; score: number } | null,
	editorial: boolean
): 'win' | 'hold' | 'conflict' {
	if (!cur) return 'win';
	if (editorial) {
		// editorial (band 900) wins unless a winner is pinned ABOVE the editorial band
		return (cur.band ?? 0) > EDITORIAL_BAND ? 'hold' : 'win';
	}
	const c = compareRank(rank, { band: cur.band, score: cur.score });
	if (rank.band !== cur.band) return c > 0 ? 'win' : 'hold';
	if (c > NEAR_SCORE_DELTA) return 'win';
	if (c < -NEAR_SCORE_DELTA) return 'hold';
	return 'conflict';
}

function outcome(
	field: string,
	op: string,
	status: PlannedFieldOutcome['status'],
	before: unknown,
	after: unknown,
	band: number,
	score: number,
	reason?: string
): PlannedFieldOutcome {
	return { field, op, status, before, after, band, score, reason };
}

function toClaim(o: PlannedFieldOutcome): ClaimOutcome {
	const status: ClaimOutcome['status'] = o.status === 'will_apply' ? 'applied' : o.status;
	return { fieldName: o.field, op: o.op, status, band: o.band, score: o.score, reason: o.reason };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface CommitOptions {
	/** Reuse an existing observation row instead of inserting a fresh one — the
	 *  Phase-4 apply path flips a `proposed` observation to `applied`. Phase 2
	 *  always inserts a fresh observation. */
	observationId?: string;
	/** Do NOT short-circuit on a recorded duplicate. The Phase-4 apply path
	 *  re-commits a change request's OWN proposed observation, which would
	 *  otherwise look like a duplicate-noop. */
	skipDupNoop?: boolean;
	/** Phase-4: the change request this commit applies (audit only). */
	changeRequestId?: string;
	/** Audit-only actor override (never precedence). */
	actor?: string;
}

/**
 * The WRITER half of the engine: take a {@link MergePlan} (whose reads are
 * already done) and perform every mutation — upsert the observed record, insert
 * the observation, materialize / attach the source, band-rank + CAS the field
 * claims, set-union links, project the flat `sources` row, write the `applied`
 * diff, and finalize the observation status. Byte-identical to the pre-refactor
 * `mergeSourceObservation` body; the plan only replaces the pure-read front
 * matter (normalize / hash / dedupe probe / audit / identity) it consumed.
 */
export async function commitMerge(
	db: Db,
	plan: MergePlan,
	opts?: CommitOptions
): Promise<MergeResult> {
	const input = plan.input;
	const nv = input.normalizerVersion ?? NORMALIZER_VERSION;
	const origin = input.origin;
	const originRecordId = input.originRecordId;
	const derivation = input.derivation;
	const confidence = input.confidence;
	const evidence = input.evidence ?? 0;
	const actor = input.actor ?? null;
	const presence = input.presence ?? 'seen';

	const appliedClaims: ClaimOutcome[] = [];
	const heldClaims: ClaimOutcome[] = [];
	const rejectedClaims: ClaimOutcome[] = [];
	const conflicts: ConflictOutcome[] = [];
	const lifecycleEvents: LifecycleOutcome[] = [];

	// 1. normalized inputs + payload hash come from the plan (pure reads done).
	const { normIds, cleanFields, safeLinks, unsafeLinks, payload, contentHash } = plan;
	for (const u of unsafeLinks) {
		rejectedClaims.push({
			fieldName: 'links',
			op: 'add',
			status: 'rejected',
			reason: `unsafe_url:${u.url}`
		});
	}

	// 2. upsert observed_record (origin, originRecordId)
	await upsertObservedRecord(db, { origin, originRecordId, contentHash, nv, presence });

	// 3. duplicate (origin,originRecordId,contentHash) ⇒ noop. The probe ran in the
	//    plan (pure read); reuse it instead of re-reading. (skipDupNoop = the
	//    Phase-4 apply path, which re-commits the CR's own proposed observation.)
	if (plan.duplicate && !opts?.skipDupNoop) {
		return {
			observationId: plan.duplicate.id,
			status: 'noop',
			appliedClaims,
			heldClaims,
			rejectedClaims,
			conflicts,
			lifecycleEvents,
			gate: plan.gate
		};
	}

	const observationId = opts?.observationId ?? uuid();
	await db.insert(sourceObservations).values({
		id: observationId,
		origin,
		originRecordId,
		contentHash,
		normalizerVersion: nv,
		runId: input.runId ?? null,
		derivation,
		confidence,
		evidence,
		payload,
		rawPayload: input.rawPayload ?? null,
		status: 'submitted',
		actor,
		createdAt: new Date()
	});

	const finalize = async (
		status: MergeResult['status'],
		sourceId?: string,
		matchDecision?: string,
		/** optional preceding writes to flush in the SAME batch as the observation
		 *  status update — lets the happy path land the projection write + the
		 *  applied-diff write + finalize in ONE subrequest instead of several.
		 *  Nullish entries are dropped, so the diff/projection writes are simply
		 *  absent on the early-return paths. Adds ZERO round-trips. */
		coWrites: Array<BatchItem<'sqlite'> | null | undefined> = []
	): Promise<MergeResult> => {
		const obsUpdate = db
			.update(sourceObservations)
			.set({ status: status === 'drift' ? 'noop' : status, matchDecision: matchDecision ?? null })
			.where(eq(sourceObservations.id, observationId));
		const writes = coWrites.filter((w): w is BatchItem<'sqlite'> => !!w);
		if (writes.length) {
			const ops: BatchItem<'sqlite'>[] = [...writes, obsUpdate as unknown as BatchItem<'sqlite'>];
			await db.batch(ops as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
		} else await obsUpdate;
		return {
			observationId,
			sourceId,
			status,
			appliedClaims,
			heldClaims,
			rejectedClaims,
			conflicts,
			lifecycleEvents,
			gate: plan.gate
		};
	};

	// 4. audit gate (pre-identity, fatal) — rejected obs is KEPT in the ledger.
	//    Computed in the plan (pure); reuse it.
	const fatal = plan.audit.fatal;
	if (fatal.length) {
		for (const f of fatal) {
			rejectedClaims.push({ fieldName: f.scope, op: 'set', status: 'rejected', reason: f.reason });
		}
		return finalize('rejected');
	}

	// 5. identity find-or-create — resolved in the plan (pure read). Reuse it.
	const decision = plan.identity;

	// 6a. upstream disappearance ⇒ drift only (NEVER mutate / delete)
	if (presence === 'missing') {
		if (decision.action === 'attach' && decision.sourceId) {
			await db.update(sources).set({ driftStatus: 'missing' }).where(eq(sources.id, decision.sourceId));
			return finalize('drift', decision.sourceId, 'missing');
		}
		return finalize('noop', undefined, 'missing_unknown');
	}

	// 6b. deliberate lifecycle op (soft delete / hide / restore / …) — needs an existing source
	if (input.lifecycle) {
		if (decision.action === 'attach' && decision.sourceId) {
			const { outcome } = await applyLifecycleOp(db, {
				sourceId: decision.sourceId,
				op: input.lifecycle.op,
				observationId,
				reason: input.lifecycle.reason,
				actor
			});
			lifecycleEvents.push(outcome);
			return finalize('applied', decision.sourceId, decision.matchDecision);
		}
		rejectedClaims.push({ fieldName: 'lifecycle', op: input.lifecycle.op, status: 'rejected', reason: 'lifecycle_target_not_found' });
		return finalize('rejected', undefined, decision.matchDecision);
	}

	// 6c. creation gate: a NEW source needs a title OR a strong id
	const willCreate = decision.action === 'create' || decision.action === 'candidate' || decision.action === 'conflict';
	if (willCreate) {
		const creationFinding = auditCreation({ hasTitle: decision.hasTitle, hasStrongId: decision.hasStrongId });
		if (creationFinding) {
			rejectedClaims.push({ fieldName: 'observation', op: 'set', status: 'rejected', reason: creationFinding.reason });
			return finalize('rejected', undefined, decision.matchDecision);
		}
	}

	// 7. materialize the source row
	let sourceId: string;
	let createdNew = false;
	if (decision.action === 'attach' && decision.sourceId) {
		sourceId = decision.sourceId;
	} else {
		// Assemble the new source row + its 'create' lifecycle event and flush both
		// in ONE batch (parent first, then the FK-referencing event) — one subrequest
		// instead of two sequential inserts.
		const built = await buildSourceRow(db, {
			fields: cleanFields,
			status: decision.status,
			origin,
			nv,
			candidate: decision.status === 'candidate'
		});
		sourceId = built.id;
		createdNew = true;
		await db.batch([
			db.insert(sources).values(built.values),
			db.insert(sourceLifecycleEvents).values({
				sourceId,
				observationId,
				eventType: 'create',
				toStatus: decision.status,
				reason: `merge create (${decision.matchDecision})`,
				actor,
				createdAt: new Date()
			})
		]);
		lifecycleEvents.push({ eventType: 'create', toStatus: decision.status });

		// candidate / conflict ⇒ same-work candidate relation(s) to the existing source(s)
		const relTargets =
			decision.action === 'conflict'
				? decision.conflictSourceIds ?? []
				: decision.candidateOf
					? [decision.candidateOf]
					: [];
		for (const target of relTargets) {
			await addCandidateRelation(db, sourceId, target, observationId, origin);
			conflicts.push({
				kind: decision.action === 'conflict' ? 'strong_multi' : 'candidate_duplicate',
				detail: `candidate same-work of ${target} (${decision.matchDecision})`,
				sourceIds: [sourceId, target]
			});
		}
	}

	// 8. attach identifiers (conflict ⇒ candidate flag, never move)
	const idConflicts = await attachIdentifiers(db, sourceId, normIds, observationId, origin, confidence);
	conflicts.push(...idConflicts);

	// 9. per-field claims + band-rank + CAS apply (llm restrictions from the plan)
	const llm = plan.audit.llm;
	const explicitDeletes = new Set(input.explicitDeletes ?? []);
	const fieldsToProcess = new Set<string>([...Object.keys(cleanFields), ...explicitDeletes]);

	// Read the CURRENT winner for every field up front in ONE round-trip (instead
	// of one read per field below). Each scalar field needs its current winner for
	// the no-op / empty-overwrite guard; batching that read is the single biggest
	// round-trip reduction on the website edit path against the stateless Worker
	// client. Per-field provenance is independent and each field is processed once,
	// so this snapshot is a valid seed; the CAS apply re-reads on contention. A
	// JUST-created source has no provenance yet, so skip the read entirely.
	const provByField = createdNew
		? new Map<string, ProvenanceRow>()
		: await readAllProvenance(db, sourceId);

	// An editorial_decision is band 900 — the TOP band — so it DETERMINISTICALLY
	// wins every scalar / controlled / set / notes / explicit_delete field against
	// any existing claim (a later editorial replaces a prior editorial). There is
	// therefore NO CAS contention to resolve: instead of the per-field
	// read-decide-conditional-update triple (one autocommit round-trip each — the
	// Worker-subrequest blowup the cutover hit), we ASSEMBLE every winning claim +
	// its provenance upsert and flush them in ONE `db.batch` (claims first, then
	// the provenance rows that FK-reference them — parent-before-child, one
	// transaction, one round-trip). No-loss is intact: superseded claims stay in
	// `source_field_claims`; only the provenance high-water pointer advances. The
	// genuine CAS path below is kept verbatim for NON-editorial (contended) writes.
	const isEditorialObs = derivation === 'editorial_decision';
	const editorialClaimRows: Array<typeof sourceFieldClaims.$inferInsert> = [];
	const editorialProvOps: Array<{ fieldName: string; write: ProvenanceWrite }> = [];
	const editorialNow = new Date();

	// The ONLY editorial field whose batched value depends on the current state is
	// `notes` (append below an equal/lower winner — #34/B2). Read its current
	// winning text once, up front, so the editorial flush needs no per-field read.
	let existingNotesText = '';
	if (isEditorialObs) {
		const notesProv = provByField.get('notes');
		const editsNotes = 'notes' in cleanFields && !explicitDeletes.has('notes') && CLAIMABLE.has('notes');
		// Skip the read when the submitted notes already EQUAL the current winner
		// (the common "re-submit the whole form unchanged" edit) — it is a no-op, so
		// the existing text is never needed.
		const incomingNotes = cleanFields['notes'];
		const notesUnchanged =
			typeof incomingNotes === 'string' && hashValue(incomingNotes) === notesProv?.valueHash;
		if (editsNotes && notesProv?.currentClaimId && !notesUnchanged) {
			const [c] = await db
				.select({ value: sourceFieldClaims.value })
				.from(sourceFieldClaims)
				.where(eq(sourceFieldClaims.id, notesProv.currentClaimId))
				.limit(1);
			if (typeof c?.value === 'string') existingNotesText = c.value;
		}
	}

	const planEditorial = (
		field: string,
		value: unknown,
		valueHash: string,
		op: string,
		rank: Rank,
		meta: { origin: string; derivation: string; confidence: number; evidence: number },
		write: ProvenanceWrite
	) => {
		const id = uuid();
		write.currentClaimId = id;
		editorialClaimRows.push({
			id,
			observationId,
			sourceId,
			fieldName: field,
			value: value as unknown as Record<string, unknown>,
			valueHash,
			op,
			rankBand: rank.band,
			rankScore: rank.score,
			origin: meta.origin,
			derivation: meta.derivation,
			confidence: meta.confidence,
			evidence: meta.evidence,
			status: 'applied', // editorial deterministically wins — no 'submitted' → re-stamp
			createdAt: editorialNow
		});
		editorialProvOps.push({ fieldName: field, write });
		appliedClaims.push({ fieldName: field, op, status: 'applied', valueHash, band: rank.band, score: rank.score });
	};

	for (const field of fieldsToProcess) {
		if (!CLAIMABLE.has(field)) continue;
		const policy = FIELD_POLICIES[field];
		const isExplicitDelete = explicitDeletes.has(field);
		const value = isExplicitDelete ? null : cleanFields[field];

		// LLM may not assert restricted fields without evidence
		if (llm.rejectedFields.includes(field)) {
			rejectedClaims.push({ fieldName: field, op: 'set', status: 'rejected', reason: 'llm_restricted' });
			continue;
		}
		// editorial_only: only an editorial decision may set it
		if (policy.policy === 'editorial_only' && derivation !== 'editorial_decision') {
			rejectedClaims.push({ fieldName: field, op: 'set', status: 'rejected', reason: 'editorial_only_field' });
			continue;
		}
		// controlled enum validation (rejected claim persisted, never silent)
		if (
			policy.policy === 'controlled_scalar_ranked' &&
			!isExplicitDelete &&
			!isEmptyValue(value) &&
			policy.enum &&
			!policy.enum.has(String(value))
		) {
			rejectedClaims.push({ fieldName: field, op: 'set', status: 'rejected', reason: 'invalid_enum' });
			continue;
		}

		const rank = rankOf(field, { derivation, origin, confidence, evidence });
		const meta = { origin: normalizeOrigin(origin), derivation, confidence, evidence };

		// ── set_union: union, never drops a member ───────────────────────────────
		if (policy.policy === 'set_union') {
			if (isExplicitDelete || isEmptyValue(value)) continue; // set fields are not cleared here
			const incoming = Array.isArray(value) ? (value as string[]) : [];
			if (isEditorialObs) {
				// editorial REPLACES with EXACTLY the incoming member set (#34 removal
				// sticks). No existing-member read needed; noop guarded by valueHash.
				const merged = [...new Set(incoming)].sort();
				const valueHash = hashValue(merged);
				const prov = provByField.get(field);
				if (prov && prov.valueHash === valueHash) {
					appliedClaims.push({ fieldName: field, op: 'set', status: 'noop', valueHash, band: rank.band, score: rank.score });
					continue;
				}
				planEditorial(field, merged, valueHash, 'set', rank, meta, provWrite(null, valueHash, rank, meta));
				continue;
			}
			const out = await applySetUnion(db, sourceId, field, observationId, incoming, rank, meta);
			pushOutcome(field, 'add', out, rank, appliedClaims, heldClaims, conflicts);
			continue;
		}

		// existing winner (also used for the empty-overwrite guard) — from the single
		// up-front provenance read, not a per-field round-trip.
		const prov = provByField.get(field);
		const hasExistingNonEmpty = !!prov && prov.valueHash !== NULL_HASH;

		// empty overwriting non-empty without an explicit delete ⇒ rejected
		if (isEmptyOverwrite({ incomingValue: value, hasExistingNonEmpty, isExplicitDelete })) {
			rejectedClaims.push({ fieldName: field, op: 'set', status: 'rejected', reason: 'empty_overwrite' });
			continue;
		}
		// empty + nothing to delete ⇒ no claim
		if (!isExplicitDelete && isEmptyValue(value)) continue;

		const op = isExplicitDelete ? 'explicit_delete' : policy.policy === 'append_or_ranked' ? 'append' : 'set';

		// ── append_or_ranked (notes): replace if it wins, else append (no loss) ───
		if (policy.policy === 'append_or_ranked' && !isExplicitDelete) {
			if (isEditorialObs) {
				// Mirror applyNotes' #34/B2 semantics with the up-front winner snapshot:
				// editorial REPLACES a lower/empty winner, APPENDS to an equal-rank
				// editorial winner (keeping the high-water rank), and is a no-op when the
				// text is already present — all deterministic, so it joins the batch.
				const text = String(value);
				const cur = prov ? { band: prov.rankBand ?? 0, score: prov.rankScore ?? 0 } : null;
				if (cur && (existingNotesText === text || existingNotesText.includes(text))) {
					appliedClaims.push({ fieldName: field, op, status: 'noop', valueHash: prov?.valueHash ?? '', band: rank.band, score: rank.score });
					continue;
				}
				const wins = !cur || rank.band > cur.band || (rank.band === cur.band && rank.score - cur.score > NEAR_SCORE_DELTA);
				const nextText = wins || !existingNotesText ? text : `${existingNotesText}\n\n${text}`;
				const valueHash = hashValue(nextText);
				if (prov && prov.valueHash === valueHash) {
					appliedClaims.push({ fieldName: field, op, status: 'noop', valueHash, band: rank.band, score: rank.score });
					continue;
				}
				// Below-band append must NOT downgrade the provenance high-water mark.
				const write: ProvenanceWrite = wins
					? provWrite(null, valueHash, rank, meta)
					: {
							currentClaimId: null,
							valueHash,
							rankBand: cur!.band,
							rankScore: cur!.score,
							origin: prov!.origin ?? meta.origin,
							derivation: prov!.derivation ?? meta.derivation,
							confidence: prov!.confidence ?? meta.confidence,
							evidence: prov!.evidence ?? meta.evidence
						};
				planEditorial(field, nextText, valueHash, wins ? 'set' : 'append', rank, meta, write);
				continue;
			}
			const out = await applyNotes(db, sourceId, field, observationId, String(value), rank, prov, meta);
			pushOutcome(field, op, out, rank, appliedClaims, heldClaims, conflicts);
			continue;
		}

		// ── scalar / controlled / editorial / explicit_delete: band-rank + CAS ────
		const valueHash = hashValue(value);
		if (prov && prov.valueHash === valueHash) {
			appliedClaims.push({ fieldName: field, op, status: 'noop', valueHash, band: rank.band, score: rank.score });
			continue;
		}
		if (isEditorialObs) {
			// Editorial (band 900) deterministically WINS a scalar/controlled/delete
			// field over any real winner — EXCEPT a winner pinned ABOVE the editorial
			// band, which applyScalarCas would HOLD; preserve that (the held edit is
			// surfaced via heldClaims, never silently clobbered — N4).
			if (prov && (prov.rankBand ?? 0) > EDITORIAL_BAND) {
				pushOutcome(field, op, { outcome: 'held_below', valueHash }, rank, appliedClaims, heldClaims, conflicts);
				continue;
			}
			planEditorial(field, value, valueHash, op, rank, meta, provWrite(null, valueHash, rank, meta));
			continue;
		}
		const claimId = await insertClaim(db, {
			observationId,
			sourceId,
			fieldName: field,
			value,
			valueHash,
			op,
			rank,
			meta
		});
		// Reuse the winner we already read above instead of re-reading it inside the
		// CAS apply: a website edit fans out one autocommit round-trip PER field, so
		// the duplicate read was a measurable cost on the stateless Worker client.
		const out = await applyScalarCas(db, sourceId, field, claimId, rank, valueHash, meta, prov);
		await setClaimStatus(db, claimId, out === 'applied' ? 'applied' : out === 'noop' ? 'applied' : out);
		pushOutcome(field, op, { outcome: out, valueHash }, rank, appliedClaims, heldClaims, conflicts);
	}

	// Flush the editorial winners: all claim INSERTs then all provenance upserts in
	// ONE batch (one Worker subrequest). Claims precede provenance so the
	// current_claim_id FK resolves within the single transaction.
	if (editorialClaimRows.length) {
		const ops: BatchItem<'sqlite'>[] = [];
		for (const row of editorialClaimRows) ops.push(db.insert(sourceFieldClaims).values(row));
		for (const p of editorialProvOps) ops.push(provUpsertStmt(db, sourceId, p.fieldName, p.write));
		await db.batch(ops as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
	}

	// 10. set-union links (keeps existing IIIF / PDF / user links, never drops)
	if (safeLinks.length) {
		await mergeLinks(db, sourceId, safeLinks, observationId, { origin: normalizeOrigin(origin), derivation, confidence, evidence }, createdNew);
	}

	// 11. project winners → flat `sources`; recompute content hash. When the caller
	// owns history (skipRevision), DEFER the projection's `sources` UPDATE so it
	// rides in the same batch as the finalize observation-status UPDATE (one
	// subrequest). Harvest (writes a revision below, whose snapshot must reflect the
	// projected row) keeps the immediate write.
	const { deferred: projUpdate, before, after, baseContentHash, resultContentHash } =
		await projectAndStore(db, sourceId, explicitDeletes, !!input.skipRevision, createdNew);

	// 11b. Build the ONE 'applied' source_observation_diffs row for this commit from
	// the engine's own before→after projections (no extra read), folded into the
	// finalize batch below — so the diff write adds ZERO round-trips. `after` is null
	// only if the source vanished mid-merge; then there is nothing to diff.
	let diffWrite: BatchItem<'sqlite'> | null = null;
	if (after) {
		const sourceDiff = diffSourceProjection({
			sourceId,
			slug: (after.slug as string | null) ?? null,
			before,
			after,
			beforeHash: baseContentHash,
			afterHash: resultContentHash!,
			conflicts,
			heldClaims,
			rejectedClaims
		});
		diffWrite = db.insert(sourceObservationDiffs).values({
			id: uuid(),
			observationId,
			sourceId,
			diffKind: 'applied',
			isNewSource: createdNew,
			baseContentHash,
			resultContentHash,
			changedScalarFields: sourceDiff.changedScalarFields,
			changedCollections: sourceDiff.changedCollections,
			hasConflicts: conflicts.length > 0,
			diff: sourceDiff,
			createdAt: new Date()
		});
	}

	// 12. source_revisions row (history compat). The website paths re-stamp this
	// with the real user/summary right after, so they pass skipRevision=true and
	// write exactly one revision themselves — avoiding a buildSnapshot + insert
	// here AND a find-and-update there (the revision double-write was ~5 of the
	// edit's round-trips). Harvest callers still record history through the engine.
	if (!input.skipRevision) {
		await db.insert(sourceRevisions).values({
			sourceId,
			userId: actor,
			userName: actor,
			summary: `merge:${origin}:${decision.matchDecision}`,
			action: createdNew ? 'create' : 'update',
			snapshot: await buildSnapshot(db, sourceId)
		});
	}

	// 13. status
	let status: MergeResult['status'];
	if (decision.action === 'conflict') status = 'conflict';
	else if (decision.action === 'candidate') status = 'candidate';
	else {
		const anyApplied = appliedClaims.some((c) => c.status === 'applied') || createdNew;
		const anyProblem = rejectedClaims.length > 0 || heldClaims.length > 0 || conflicts.length > 0;
		const onlyNoop = appliedClaims.every((c) => c.status === 'noop');
		if (!anyApplied && !anyProblem && onlyNoop) status = 'noop';
		else if (anyApplied && anyProblem) status = 'partial';
		else if (anyApplied) status = 'applied';
		else status = 'partial';
	}
	return finalize(status, sourceId, decision.matchDecision, [projUpdate, diffWrite]);
}

// ---------------------------------------------------------------------------
// Propose path (Phase 3) — open a change request, write ZERO canonical data
// ---------------------------------------------------------------------------

/** A short one-line title for a change-request queue row, derived from the diff. */
function summarizeDiffTitle(diff: SourceDiff): string {
	if (diff.isNewSource) {
		const titleField = diff.scalars.find((s) => s.field === 'title');
		const t = titleField?.after;
		return `New source${typeof t === 'string' && t ? `: ${t}` : ''}`;
	}
	const n = diff.changedScalarFields.length + diff.changedCollections.length;
	const first = diff.summaryLines[0];
	if (first) return n > 1 ? `${first} (+${n - 1} more)` : first;
	return 'Change request';
}

/**
 * The PROPOSE writer (Git-in-the-DB §3): route a `propose`-gated observation to
 * the change-request (PR) queue instead of committing it. Writes EXACTLY three
 * rows in one atomic {@link Db.batch} — single round-trip, stateless-Worker-safe:
 *
 *   1. the observation itself, with `status='proposed'`;
 *   2. a `source_observation_diffs` row, `diffKind='proposal'`, holding the
 *      read-only before→after preview the plan simulated (reusing the Phase-1
 *      {@link diffSourceProjection}); and
 *   3. the `change_requests` envelope, `status='open'`.
 *
 * NO claim / CAS / `sources` / provenance / link write happens — a proposal
 * mutates ZERO canonical data; that waits for the apply phase (Phase 4). Rows are
 * inserted parent-first (observation → diff → change_request) so the
 * `restrict`/`set null` FKs resolve inside the single batch transaction even on
 * FK-enforcing remote Turso.
 *
 * REQUIRES a SIMULATED plan — call `planSourceObservation(db, input, { simulate:
 * true })` first so `plan.diff` is populated (the public entry does this on the
 * propose path).
 */
export async function openChangeRequest(db: Db, plan: MergePlan): Promise<ProposedMergeResult> {
	const input = plan.input;
	const diff = plan.diff;
	if (!diff) {
		throw new Error(
			'openChangeRequest requires a simulated plan (plan.diff is null) — call planSourceObservation with { simulate: true }'
		);
	}
	const nv = input.normalizerVersion ?? NORMALIZER_VERSION;
	const sourceId =
		plan.identity.action === 'attach' && plan.identity.sourceId ? plan.identity.sourceId : undefined;
	const hasConflicts = plan.conflicts.length > 0 || plan.predictedConflicts.length > 0;

	const observationId = uuid();
	const diffId = uuid();
	const changeRequestId = uuid();
	const stampedAt = new Date();

	await db.batch([
		// 1. the proposed observation — recorded in the ledger, never auto-applied.
		db.insert(sourceObservations).values({
			id: observationId,
			origin: input.origin,
			originRecordId: input.originRecordId,
			contentHash: plan.contentHash,
			normalizerVersion: nv,
			runId: input.runId ?? null,
			derivation: input.derivation,
			confidence: input.confidence,
			evidence: input.evidence ?? 0,
			payload: plan.payload,
			rawPayload: input.rawPayload ?? null,
			status: 'proposed',
			matchDecision: plan.identity.matchDecision,
			actor: input.actor ?? null,
			createdAt: stampedAt
		}),
		// 2. the proposal diff — the dry-run before→after preview (advisory; the
		//    apply path re-plans live before committing).
		db.insert(sourceObservationDiffs).values({
			id: diffId,
			observationId,
			sourceId: sourceId ?? null,
			diffKind: 'proposal',
			isNewSource: diff.isNewSource,
			baseContentHash: plan.baseContentHash,
			resultContentHash: plan.resultContentHash,
			changedScalarFields: diff.changedScalarFields,
			changedCollections: diff.changedCollections,
			hasConflicts,
			diff,
			createdAt: stampedAt
		}),
		// 3. the change-request envelope — the mutable PR workflow state.
		db.insert(changeRequests).values({
			id: changeRequestId,
			observationId,
			sourceId: sourceId ?? null,
			plannedSourceId: null,
			plannedSlug: null,
			kind: plan.gate.kind,
			status: 'open',
			routingReason: plan.gate.reason,
			title: summarizeDiffTitle(diff),
			summary: diff.summaryLines.length ? diff.summaryLines.join('\n') : null,
			origin: input.origin,
			originRecordId: input.originRecordId,
			derivation: input.derivation,
			confidence: input.confidence,
			evidence: input.evidence ?? 0,
			baseContentHash: plan.baseContentHash,
			resultContentHash: plan.resultContentHash,
			proposedByActor: input.actor ?? null,
			createdAt: stampedAt,
			updatedAt: stampedAt
		})
	]);

	return {
		status: 'proposed',
		observationId,
		changeRequestId,
		diffId,
		sourceId,
		gate: plan.gate,
		appliedClaims: [],
		heldClaims: plan.heldClaims,
		rejectedClaims: plan.rejectedClaims,
		conflicts: [...plan.conflicts, ...plan.predictedConflicts],
		lifecycleEvents: []
	};
}

// ---------------------------------------------------------------------------
// observed record
// ---------------------------------------------------------------------------

async function upsertObservedRecord(
	db: Db,
	args: { origin: string; originRecordId: string; contentHash: string; nv: number; presence: 'seen' | 'missing' }
): Promise<void> {
	const now = new Date();

	// 'seen' (every website edit + most harvest) is a single INSERT … ON CONFLICT
	// DO UPDATE keyed on UNIQUE(origin, origin_record_id) — one round-trip instead
	// of a select-then-insert/update. `content_changed_at` advances only when the
	// content hash actually changed (the IS-NOT mirrors the prior `!==` incl. null);
	// missing_count is left untouched (preserves the drift history). 'missing'
	// keeps the read-modify path (it must increment/seed the missing counters).
	if (args.presence === 'seen') {
		await db
			.insert(sourceObservedRecords)
			.values({
				origin: args.origin,
				originRecordId: args.originRecordId,
				status: 'seen',
				lastContentHash: args.contentHash,
				normalizerVersion: args.nv,
				firstSeenAt: now,
				lastSeenAt: now,
				contentChangedAt: now,
				missingCount: 0,
				missingSinceAt: null
			})
			.onConflictDoUpdate({
				target: [sourceObservedRecords.origin, sourceObservedRecords.originRecordId],
				set: {
					status: 'seen',
					lastContentHash: args.contentHash,
					lastSeenAt: now,
					contentChangedAt: sql`CASE WHEN ${sourceObservedRecords.lastContentHash} IS NOT ${args.contentHash} THEN ${now.getTime()} ELSE ${sourceObservedRecords.contentChangedAt} END`,
					missingSinceAt: null
				}
			});
		return;
	}

	const [existing] = await db
		.select()
		.from(sourceObservedRecords)
		.where(
			and(
				eq(sourceObservedRecords.origin, args.origin),
				eq(sourceObservedRecords.originRecordId, args.originRecordId)
			)
		)
		.limit(1);
	if (existing) {
		const changed = existing.lastContentHash !== args.contentHash;
		await db
			.update(sourceObservedRecords)
			.set({
				status: args.presence === 'missing' ? 'missing' : 'seen',
				lastContentHash: args.contentHash,
				lastSeenAt: now,
				contentChangedAt: changed ? now : existing.contentChangedAt,
				missingCount: args.presence === 'missing' ? existing.missingCount + 1 : existing.missingCount,
				missingSinceAt:
					args.presence === 'missing' ? (existing.missingSinceAt ?? now) : null
			})
			.where(eq(sourceObservedRecords.id, existing.id));
	} else {
		await db.insert(sourceObservedRecords).values({
			origin: args.origin,
			originRecordId: args.originRecordId,
			status: args.presence === 'missing' ? 'missing' : 'seen',
			lastContentHash: args.contentHash,
			normalizerVersion: args.nv,
			firstSeenAt: now,
			lastSeenAt: now,
			missingCount: args.presence === 'missing' ? 1 : 0,
			missingSinceAt: args.presence === 'missing' ? now : null
		});
	}
}

// ---------------------------------------------------------------------------
// source creation
// ---------------------------------------------------------------------------

async function ensureUniqueSlug(db: Db, base: string): Promise<string> {
	const root = base || 'source';
	let candidate = root;
	let n = 1;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		const [ex] = await db.select({ id: sources.id }).from(sources).where(eq(sources.slug, candidate)).limit(1);
		if (!ex) return candidate;
		n += 1;
		candidate = `${root}-${n}`;
	}
}

async function buildSourceRow(
	db: Db,
	args: { fields: Record<string, unknown>; status: 'active' | 'candidate'; origin: string; nv: number; candidate: boolean }
): Promise<{ id: string; values: typeof sources.$inferInsert }> {
	const id = uuid();
	const f = args.fields;
	const titleStr = typeof f.title === 'string' && f.title.trim() ? f.title : '(untitled)';
	// `type` is open-ended free text (no enum) — keep any non-empty incoming
	// value, fall back to 'other' only when absent so the NOT-NULL column is set.
	const initType = typeof f.type === 'string' && f.type.trim() ? f.type : 'other';
	const initCategory = typeof f.category === 'string' && ENUMS.category.has(f.category) ? f.category : 'primary';

	let slug: string;
	if (args.candidate) {
		const short = id.slice(0, 8);
		const tail = slugify(titleStr) || 'source';
		slug = await ensureUniqueSlug(db, `cand-${short}-${tail}`);
	} else {
		slug = await ensureUniqueSlug(db, slugify((f.titleEn as string) || titleStr) || 'source');
	}

	const now = new Date();
	return {
		id,
		values: {
			id,
			slug,
			title: titleStr,
			type: initType,
			category: initCategory,
			status: args.status,
			provenanceRepo: normalizeOrigin(args.origin) || 'manual',
			normalizerVersion: args.nv,
			firstSeenAt: now,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now
		}
	};
}

async function addCandidateRelation(
	db: Db,
	fromId: string,
	toId: string,
	observationId: string,
	origin: string
): Promise<void> {
	const [ex] = await db
		.select({ id: sourceRelations.id })
		.from(sourceRelations)
		.where(
			and(
				eq(sourceRelations.fromSourceId, fromId),
				eq(sourceRelations.toSourceId, toId),
				eq(sourceRelations.type, 'same-work')
			)
		)
		.limit(1);
	if (ex) return;
	await db.insert(sourceRelations).values({
		fromSourceId: fromId,
		toSourceId: toId,
		type: 'same-work',
		status: 'candidate',
		origin: normalizeOrigin(origin),
		derivation: 'inferred',
		observationId
	});
}

// ---------------------------------------------------------------------------
// identifiers
// ---------------------------------------------------------------------------

async function attachIdentifiers(
	db: Db,
	sourceId: string,
	normIds: NormalizedIdentifier[],
	observationId: string,
	origin: string,
	confidence: number
): Promise<ConflictOutcome[]> {
	const conflicts: ConflictOutcome[] = [];
	const now = new Date();
	for (const id of normIds) {
		if (!id.valid) continue;
		const [existing] = await db
			.select()
			.from(sourceIdentifiers)
			.where(and(eq(sourceIdentifiers.kind, id.kind), eq(sourceIdentifiers.valueNorm, id.valueNorm)))
			.limit(1);
		if (existing) {
			if (existing.sourceId === sourceId) {
				await db.update(sourceIdentifiers).set({ lastSeenAt: now }).where(eq(sourceIdentifiers.id, existing.id));
			} else if (existing.sourceId && existing.sourceId !== sourceId) {
				// same id held by another source ⇒ conflict; NEVER move it
				conflicts.push({
					kind: 'identifier_conflict',
					detail: `${id.kind}:${id.valueNorm} already held by ${existing.sourceId}`,
					sourceIds: [existing.sourceId, sourceId]
				});
			}
		} else {
			await db.insert(sourceIdentifiers).values({
				sourceId,
				kind: id.kind,
				valueRaw: id.valueRaw,
				valueNorm: id.valueNorm,
				strength: id.strength,
				status: 'active',
				origin: normalizeOrigin(origin),
				confidence,
				observationId,
				firstSeenAt: now,
				lastSeenAt: now
			});
		}

		// redirect: attach canonical to this source, mark the alias redirected
		if (id.redirectsToNorm && id.redirectsToNorm !== id.valueNorm) {
			let canonId: string;
			const [canon] = await db
				.select()
				.from(sourceIdentifiers)
				.where(and(eq(sourceIdentifiers.kind, id.kind), eq(sourceIdentifiers.valueNorm, id.redirectsToNorm)))
				.limit(1);
			if (canon) {
				canonId = canon.id;
				if (canon.sourceId !== sourceId && canon.sourceId) {
					conflicts.push({
						kind: 'identifier_conflict',
						detail: `redirect target ${id.kind}:${id.redirectsToNorm} held by ${canon.sourceId}`,
						sourceIds: [canon.sourceId, sourceId]
					});
				}
			} else {
				canonId = uuid();
				await db.insert(sourceIdentifiers).values({
					id: canonId,
					sourceId,
					kind: id.kind,
					valueRaw: id.redirectsToNorm,
					valueNorm: id.redirectsToNorm,
					strength: id.strength,
					status: 'active',
					origin: normalizeOrigin(origin),
					confidence,
					observationId,
					firstSeenAt: now,
					lastSeenAt: now
				});
			}
			const [self] = await db
				.select()
				.from(sourceIdentifiers)
				.where(and(eq(sourceIdentifiers.kind, id.kind), eq(sourceIdentifiers.valueNorm, id.valueNorm)))
				.limit(1);
			if (self && self.id !== canonId) {
				await db
					.update(sourceIdentifiers)
					.set({ status: 'redirected', redirectsToIdentifierId: canonId, canonicalValueNorm: id.redirectsToNorm })
					.where(eq(sourceIdentifiers.id, self.id));
			}
		}
	}
	return conflicts;
}

// ---------------------------------------------------------------------------
// claims + CAS
// ---------------------------------------------------------------------------

interface ClaimInsert {
	observationId: string;
	sourceId: string;
	fieldName: string;
	value: unknown;
	valueHash: string;
	op: string;
	rank: Rank;
	meta: { origin: string; derivation: string; confidence: number; evidence: number };
}

async function insertClaim(db: Db, c: ClaimInsert): Promise<string> {
	const id = uuid();
	const res = await db
		.insert(sourceFieldClaims)
		.values({
			id,
			observationId: c.observationId,
			sourceId: c.sourceId,
			fieldName: c.fieldName,
			value: c.value as unknown as Record<string, unknown>,
			valueHash: c.valueHash,
			op: c.op,
			rankBand: c.rank.band,
			rankScore: c.rank.score,
			origin: c.meta.origin,
			derivation: c.meta.derivation,
			confidence: c.meta.confidence,
			evidence: c.meta.evidence,
			status: 'submitted',
			createdAt: new Date()
		})
		.onConflictDoNothing();
	if (rowsAffected(res) > 0) return id;
	const [existing] = await db
		.select({ id: sourceFieldClaims.id })
		.from(sourceFieldClaims)
		.where(
			and(
				eq(sourceFieldClaims.observationId, c.observationId),
				eq(sourceFieldClaims.fieldName, c.fieldName),
				eq(sourceFieldClaims.valueHash, c.valueHash)
			)
		)
		.limit(1);
	return existing?.id ?? id;
}

async function setClaimStatus(db: Db, claimId: string, status: string): Promise<void> {
	await db.update(sourceFieldClaims).set({ status }).where(eq(sourceFieldClaims.id, claimId));
}

type ScalarOutcome = 'applied' | 'held_below' | 'conflict' | 'noop';

function provWrite(
	claimId: string | null,
	valueHash: string,
	rank: Rank,
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): ProvenanceWrite {
	return {
		currentClaimId: claimId,
		valueHash,
		rankBand: rank.band,
		rankScore: rank.score,
		origin: meta.origin,
		derivation: meta.derivation,
		confidence: meta.confidence,
		evidence: meta.evidence
	};
}

/**
 * An UNCONDITIONAL provenance upsert keyed on UNIQUE(source_id, field_name) — the
 * batched write for an editorial (deterministically winning) claim. Correct &
 * no-loss: editorial is the top band so it always becomes the winner, which is
 * exactly what an unconditional `ON CONFLICT … DO UPDATE` records; the prior
 * winning claim is untouched in `source_field_claims`. (The CAS path's CONDITIONAL
 * `WHERE current_claim_id = ?` is only needed for contended NON-editorial writes.)
 */
function provUpsertStmt(db: Db, sourceId: string, fieldName: string, w: ProvenanceWrite) {
	const row = {
		currentClaimId: w.currentClaimId,
		valueHash: w.valueHash,
		rankBand: w.rankBand,
		rankScore: w.rankScore,
		origin: w.origin,
		derivation: w.derivation,
		confidence: w.confidence,
		evidence: w.evidence,
		updatedAt: new Date()
	};
	return db
		.insert(sourceFieldProvenance)
		.values({ sourceId, fieldName, ...row })
		.onConflictDoUpdate({
			target: [sourceFieldProvenance.sourceId, sourceFieldProvenance.fieldName],
			set: row
		});
}

/** Band-first CAS apply for a scalar/controlled/editorial/explicit_delete claim. */
async function applyScalarCas(
	db: Db,
	sourceId: string,
	field: string,
	claimId: string,
	rank: Rank,
	valueHash: string,
	meta: { origin: string; derivation: string; confidence: number; evidence: number },
	/** the current winner the caller already read (avoids a duplicate round-trip);
	 *  the CAS loop still re-reads on contention, so concurrency safety is intact. */
	initialProv?: ProvenanceRow
): Promise<ScalarOutcome> {
	const editorial = rank.band === EDITORIAL_BAND;
	let prov = initialProv ?? (await readProvenance(db, sourceId, field));

	if (!prov) {
		const inserted = await casInsertFirst(db, sourceId, field, provWrite(claimId, valueHash, rank, meta));
		if (inserted) return 'applied';
		prov = await readProvenance(db, sourceId, field);
	}

	for (let attempt = 0; attempt < CAS_MAX_RETRY; attempt++) {
		if (!prov) {
			const inserted = await casInsertFirst(db, sourceId, field, provWrite(claimId, valueHash, rank, meta));
			if (inserted) return 'applied';
			prov = await readProvenance(db, sourceId, field);
			continue;
		}
		if (prov.valueHash === valueHash) return 'noop';
		const cur = { band: prov.rankBand ?? 0, score: prov.rankScore ?? 0 };

		let decision: 'win' | 'hold' | 'conflict';
		if (rank.band > cur.band) decision = 'win';
		else if (rank.band < cur.band) decision = 'hold';
		else if (editorial && prov.rankBand === EDITORIAL_BAND)
			decision = 'win'; // later editorial replaces prior editorial (wiki)
		else {
			const diff = rank.score - cur.score;
			if (diff > NEAR_SCORE_DELTA) decision = 'win';
			else if (diff < -NEAR_SCORE_DELTA) decision = 'hold';
			else decision = 'conflict';
		}

		if (decision === 'hold') return 'held_below';
		if (decision === 'conflict') return 'conflict';

		const ok = await casUpdate(db, sourceId, field, prov.currentClaimId, provWrite(claimId, valueHash, rank, meta));
		if (ok) return 'applied';
		prov = await readProvenance(db, sourceId, field); // contended → re-read + retry
	}
	return 'held_below'; // exhausted retries → lose cleanly, no clobber
}

interface SetOutcome {
	outcome: ScalarOutcome;
	valueHash: string;
}

/**
 * set_union (languages / scripts / altTitles).
 *
 * Chosen semantics (documented for the cutover):
 *   - editorial_decision (band 900) is AUTHORITATIVE: the field is set to EXACTLY
 *     the claim's member set, so an editor de-selecting a wrong member (a REMOVAL)
 *     actually takes effect rather than being a silent no-op (N4). This is the
 *     cutover blocker the reviews flagged: set-union was additive-only.
 *   - every LOWER band (machine / curated) keeps the additive union with the
 *     CURRENT winner — it can only ADD members, never drop one a higher band held.
 *     So after an editorial baseline of ['ain'], a machine ['rus'] → ['ain','rus'].
 *
 * No-loss is preserved: a superseded member is NEVER erased from the ledger — every
 * prior claim (and its members) stays in `source_field_claims`; only the PROJECTED
 * winner set changes. (Union is rank-agnostic, so a later machine harvest that
 * re-asserts a removed member would re-add it to the projection — persistent removal
 * is therefore an editorial act, by design.)
 */
async function applySetUnion(
	db: Db,
	sourceId: string,
	field: string,
	observationId: string,
	incoming: string[],
	rank: Rank,
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): Promise<SetOutcome> {
	const editorial = rank.band === EDITORIAL_BAND;
	for (let attempt = 0; attempt < CAS_MAX_RETRY; attempt++) {
		const prov = await readProvenance(db, sourceId, field);
		let existing: string[] = [];
		if (prov?.currentClaimId) {
			const [c] = await db
				.select({ value: sourceFieldClaims.value })
				.from(sourceFieldClaims)
				.where(eq(sourceFieldClaims.id, prov.currentClaimId))
				.limit(1);
			if (Array.isArray(c?.value)) existing = c!.value as string[];
		}
		// editorial REPLACES (exact member set ⇒ removals stick); machine UNIONS.
		const merged = editorial
			? [...new Set(incoming)].sort()
			: [...new Set([...existing, ...incoming])].sort();
		const valueHash = hashValue(merged);
		if (prov && prov.valueHash === valueHash) return { outcome: 'noop', valueHash };

		const claimId = await insertClaim(db, {
			observationId,
			sourceId,
			fieldName: field,
			value: merged,
			valueHash,
			op: editorial ? 'set' : 'add',
			rank,
			meta
		});
		if (!prov) {
			const inserted = await casInsertFirst(db, sourceId, field, provWrite(claimId, valueHash, rank, meta));
			if (inserted) {
				await setClaimStatus(db, claimId, 'applied');
				return { outcome: 'applied', valueHash };
			}
			continue; // race → retry
		}
		const ok = await casUpdate(db, sourceId, field, prov.currentClaimId, provWrite(claimId, valueHash, rank, meta));
		if (ok) {
			await setClaimStatus(db, claimId, 'applied');
			return { outcome: 'applied', valueHash };
		}
		// contended → retry
	}
	return { outcome: 'held_below', valueHash: '' };
}

/** append_or_ranked (notes): replace if the claim outranks, else append (no loss). */
async function applyNotes(
	db: Db,
	sourceId: string,
	field: string,
	observationId: string,
	incomingText: string,
	rank: Rank,
	prov: Awaited<ReturnType<typeof readProvenance>>,
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): Promise<SetOutcome> {
	// Bounded CAS retry (mirrors applyScalarCas) so a concurrent note write is not
	// lost: a failed casUpdate or a lost casInsertFirst create-race re-reads the
	// winner and retries instead of silently returning 'applied' (Codex/Fugu B2).
	let current = prov;
	for (let attempt = 0; attempt < CAS_MAX_RETRY; attempt++) {
		let existing = '';
		if (current?.currentClaimId) {
			const [c] = await db
				.select({ value: sourceFieldClaims.value })
				.from(sourceFieldClaims)
				.where(eq(sourceFieldClaims.id, current.currentClaimId))
				.limit(1);
			if (typeof c?.value === 'string') existing = c.value;
		}

		// first note for this field — no winner yet
		if (!current) {
			const valueHash = hashValue(incomingText);
			const claimId = await insertClaim(db, { observationId, sourceId, fieldName: field, value: incomingText, valueHash, op: 'set', rank, meta });
			const inserted = await casInsertFirst(db, sourceId, field, provWrite(claimId, valueHash, rank, meta));
			if (inserted) {
				await setClaimStatus(db, claimId, 'applied');
				return { outcome: 'applied', valueHash };
			}
			current = await readProvenance(db, sourceId, field); // lost create race → fall into the update path
			continue;
		}

		if (existing === incomingText || existing.includes(incomingText)) {
			return { outcome: 'noop', valueHash: current.valueHash ?? '' };
		}

		const cur = { band: current.rankBand ?? 0, score: current.rankScore ?? 0 };
		const wins = rank.band > cur.band || (rank.band === cur.band && rank.score - cur.score > NEAR_SCORE_DELTA);
		const nextText = wins ? incomingText : `${existing}\n\n${incomingText}`;
		const valueHash = hashValue(nextText);
		const claimId = await insertClaim(db, { observationId, sourceId, fieldName: field, value: nextText, valueHash, op: wins ? 'set' : 'append', rank, meta });

		// When appending BELOW the current winner, KEEP the winner's rank (and its
		// origin/derivation/confidence/evidence) on the provenance high-water mark —
		// the appended text is added but the field's rank must NOT downgrade. Writing
		// the incoming low rank (e.g. 900→700) would let a later band-700 note "win"
		// and REPLACE the whole field, dropping the original editorial text (B2).
		// Equivalent to modelling the winner rank as max(existing, incoming).
		const write: ProvenanceWrite = wins
			? provWrite(claimId, valueHash, rank, meta)
			: {
					currentClaimId: claimId,
					valueHash,
					rankBand: cur.band,
					rankScore: cur.score,
					origin: current.origin ?? meta.origin,
					derivation: current.derivation ?? meta.derivation,
					confidence: current.confidence ?? meta.confidence,
					evidence: current.evidence ?? meta.evidence
				};
		const ok = await casUpdate(db, sourceId, field, current.currentClaimId, write);
		if (ok) {
			await setClaimStatus(db, claimId, 'applied');
			return { outcome: 'applied', valueHash };
		}
		await setClaimStatus(db, claimId, 'superseded');
		current = await readProvenance(db, sourceId, field); // contended → re-read + retry
	}
	return { outcome: 'held_below', valueHash: '' };
}

function pushOutcome(
	field: string,
	op: string,
	out: { outcome: ScalarOutcome; valueHash: string },
	rank: Rank,
	applied: ClaimOutcome[],
	held: ClaimOutcome[],
	conflicts: ConflictOutcome[]
): void {
	const oc: ClaimOutcome = { fieldName: field, op, status: out.outcome, valueHash: out.valueHash, band: rank.band, score: rank.score };
	if (out.outcome === 'held_below') held.push(oc);
	else if (out.outcome === 'conflict') {
		held.push(oc);
		conflicts.push({ kind: 'field_conflict', fieldName: field, detail: `same-band conflict on ${field}` });
	} else applied.push(oc);
}

// ---------------------------------------------------------------------------
// links (set-union)
// ---------------------------------------------------------------------------

async function mergeLinks(
	db: Db,
	sourceId: string,
	links: Array<{ type: string; url: string; label: string | null }>,
	observationId: string,
	meta: { origin: string; derivation: string; confidence: number; evidence: number },
	/** a JUST-created source has no links yet — skip the existing-links read */
	createdNew = false
): Promise<void> {
	const existing = createdNew ? [] : await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId));
	const key = (t: string, u: string) => `${t}\n${u}`;
	const have = new Map(existing.map((l) => [key(l.type, l.url), l]));
	const now = new Date();
	let order = existing.length;
	for (const l of links) {
		const k = key(l.type, l.url);
		const hit = have.get(k);
		if (hit) {
			await db.update(sourceLinks).set({ lastSeenAt: now, status: 'active' }).where(eq(sourceLinks.id, hit.id));
			continue;
		}
		await db.insert(sourceLinks).values({
			sourceId,
			type: l.type,
			url: l.url,
			label: l.label,
			sortOrder: order++,
			status: 'active',
			origin: meta.origin,
			derivation: meta.derivation,
			confidence: meta.confidence,
			evidence: meta.evidence,
			observationId,
			firstSeenAt: now,
			lastSeenAt: now
		});
		have.set(k, { id: '' } as never);
	}
}

// ---------------------------------------------------------------------------
// projection → flat sources + content hash
// ---------------------------------------------------------------------------

interface ProjectionResult {
	deferred: BatchItem<'sqlite'> | null;
	/** the canonical projection BEFORE this merge (pre-overlay flat row + children);
	 *  null for a just-created source (the diff is then a brand-new-source add). */
	before: SourceProjection | null;
	/** the canonical projection AFTER this merge (flat row overlaid with winners). */
	after: SourceProjection | null;
	/** the source's stored content hash before this merge (diff staleness base). */
	baseContentHash: string | null;
	/** the recomputed content hash after this merge. */
	resultContentHash: string | null;
}

async function projectAndStore(
	db: Db,
	sourceId: string,
	explicitDeletes: Set<string>,
	/** when true, RETURN the `sources` update statement unexecuted so the caller can
	 *  batch it with the finalize write; when false, execute it immediately. The
	 *  statement is wrapped in an object because a drizzle query builder is THENABLE
	 *  — returning it bare from an async fn would auto-execute it at the await. */
	defer = false,
	/** a JUST-created source's "before" is null (a brand-new-source diff). */
	createdNew = false
): Promise<ProjectionResult> {
	// One BATCH for every projection input (winning claims + the flat row + all
	// related rows) — a single Worker subrequest instead of a sequential/parallel
	// fan-out of single-statement round-trips. The flat field winners and the
	// content hash are then written in ONE combined `sources` UPDATE (the two
	// separate updates — field projection, then content hash — collapse to one).
	const [winners, srcRows, links, tagRows, personRows, placeRows, instRows, relOut, relIn] = await db.batch([
		db
			.select({ field: sourceFieldClaims.fieldName, value: sourceFieldClaims.value, op: sourceFieldClaims.op })
			.from(sourceFieldProvenance)
			.innerJoin(sourceFieldClaims, eq(sourceFieldProvenance.currentClaimId, sourceFieldClaims.id))
			.where(eq(sourceFieldProvenance.sourceId, sourceId)),
		db.select().from(sources).where(eq(sources.id, sourceId)).limit(1),
		db
			.select()
			.from(sourceLinks)
			.where(and(eq(sourceLinks.sourceId, sourceId), eq(sourceLinks.status, 'active'))),
		db
			.select({ name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id))
			.where(eq(sourceTags.sourceId, sourceId)),
		db
			.select({ slug: persons.slug, role: sourcePersons.role, sortOrder: sourcePersons.sortOrder })
			.from(sourcePersons)
			.innerJoin(persons, eq(sourcePersons.personId, persons.id))
			.where(eq(sourcePersons.sourceId, sourceId)),
		db
			.select({ slug: places.slug, role: sourcePlaces.role, notes: sourcePlaces.notes })
			.from(sourcePlaces)
			.innerJoin(places, eq(sourcePlaces.placeId, places.id))
			.where(eq(sourcePlaces.sourceId, sourceId)),
		db
			.select({ slug: institutions.slug, role: sourceInstitutions.role, callNumber: sourceInstitutions.callNumber, notes: sourceInstitutions.notes })
			.from(sourceInstitutions)
			.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id))
			.where(eq(sourceInstitutions.sourceId, sourceId)),
		db
			.select({ to: sourceRelations.toSourceId, type: sourceRelations.type })
			.from(sourceRelations)
			.where(eq(sourceRelations.fromSourceId, sourceId)),
		db
			.select({ from: sourceRelations.fromSourceId, type: sourceRelations.type })
			.from(sourceRelations)
			.where(eq(sourceRelations.toSourceId, sourceId))
	]);

	const src = srcRows[0];
	if (!src) return { deferred: null, before: null, after: null, baseContentHash: null, resultContentHash: null };

	const winnerOp = new Map<string, string>();
	const upd: Record<string, unknown> = {};
	for (const r of winners) {
		if (!CLAIMABLE.has(r.field)) continue;
		upd[r.field] = r.value;
		winnerOp.set(r.field, r.op);
	}
	// An explicit delete clears the flat projection ONLY when the delete CLAIM
	// actually WON CAS — i.e. it is the current `source_field_provenance` winner
	// for that field (op='explicit_delete'). A delete that was held_below / rejected
	// by CAS (e.g. a LOW-band machine delete vs. a curated/editorial value) leaves
	// the prior winner intact; nulling it unconditionally here let a low-band delete
	// clobber a value CAS correctly held (Codex BLOCKER B1).
	for (const f of explicitDeletes) {
		if (CLAIMABLE.has(f) && winnerOp.get(f) === 'explicit_delete') upd[f] = null;
	}

	// Endpoint slugs for relations (only when the source has any) — one extra read.
	const endpointIds = [...relOut.map((r) => r.to), ...relIn.map((r) => r.from)];
	const slugMap = new Map<string, string>();
	if (endpointIds.length) {
		const rows = await db.select({ id: sources.id, slug: sources.slug }).from(sources).where(inArray(sources.id, endpointIds));
		for (const r of rows) slugMap.set(r.id, r.slug);
	}
	const relations = [
		...relOut.map((r) => ({ type: r.type, toSlugOrId: slugMap.get(r.to) ?? r.to, direction: 'out' as const })),
		...relIn.map((r) => ({ type: r.type, toSlugOrId: slugMap.get(r.from) ?? r.from, direction: 'in' as const }))
	];
	// The shared child inputs for the before/after projections — built once.
	const childInputs = {
		links,
		tags: tagRows.map((t) => t.name),
		persons: personRows,
		places: placeRows,
		institutions: instRows,
		relations
	};
	// Compute the projection from the row OVERLAID with the new field winners (we
	// already hold them) — equivalent to writing them first then re-reading, but
	// without the extra round-trip; the content hash is then exact for one UPDATE.
	const after = projectSource({
		source: { ...(src as unknown as Record<string, unknown>), ...upd },
		...childInputs
	});
	const hash = hashProjection(after);

	// The "before" projection reuses the SAME children with the PRE-overlay flat row
	// (the `sources` UPDATE below is deferred / not yet run, so `src` still holds the
	// pre-merge scalars). It costs no extra round-trip. A just-created source has no
	// prior state, so its before is null (a brand-new-source diff). NB: collections
	// are read post-write, so before/after collections match — the applied diff
	// surfaces SCALAR field changes (the editorial-edit case); collection deltas are
	// a later-phase concern.
	const before = createdNew
		? null
		: projectSource({ source: src as unknown as Record<string, unknown>, ...childInputs });
	const baseContentHash = createdNew ? null : (src.contentHash ?? null);

	const now = new Date();
	const finalUpd: Record<string, unknown> = { ...upd, contentHash: hash, updatedAt: now, lastSeenAt: now };
	if (src.contentHash !== hash) finalUpd.contentChangedAt = now;
	const stmt = db.update(sources).set(finalUpd).where(eq(sources.id, sourceId));
	const result: ProjectionResult = {
		deferred: defer ? (stmt as unknown as BatchItem<'sqlite'>) : null,
		before,
		after,
		baseContentHash,
		resultContentHash: hash
	};
	if (!defer) await stmt;
	return result;
}

// ---------------------------------------------------------------------------
// revision snapshot
// ---------------------------------------------------------------------------

async function buildSnapshot(db: Db, sourceId: string): Promise<Record<string, unknown>> {
	// One batch (one subrequest) for the three snapshot reads.
	const [srcRows, links, tagRows] = await db.batch([
		db.select().from(sources).where(eq(sources.id, sourceId)).limit(1),
		db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId)),
		db
			.select({ name: tags.name })
			.from(sourceTags)
			.innerJoin(tags, eq(sourceTags.tagId, tags.id))
			.where(eq(sourceTags.sourceId, sourceId))
	]);
	const src = srcRows[0];
	if (!src) return {};
	return { source: src, links, tags: tagRows.map((t) => t.name) };
}
