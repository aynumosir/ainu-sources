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
import { and, eq, inArray } from 'drizzle-orm';
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
	sourceRevisions
} from '../db/schema';
import { projectSource, hashProjection } from '../golden';
import type {
	Db,
	MergeInput,
	MergeResult,
	ClaimOutcome,
	ConflictOutcome,
	LifecycleOutcome
} from './types';
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
import { rankOf, EDITORIAL_BAND, NEAR_SCORE_DELTA, normalizeOrigin, type Rank } from './rank';
import { auditIngest, auditCreation, auditLlmAssertions, isEmptyOverwrite } from './audit-gate';
import { resolveIdentity } from './identity';
import {
	readProvenance,
	casInsertFirst,
	casUpdate,
	CAS_MAX_RETRY,
	type ProvenanceWrite
} from './cas';
import { applyLifecycleOp, softMerge, writeLifecycleEvent } from './lifecycle';

const uuid = () => crypto.randomUUID();
const NULL_HASH = hashValue(null);
const CLAIMABLE = new Set(CLAIMABLE_FIELDS);

function rowsAffected(res: unknown): number {
	return (res as { rowsAffected?: number })?.rowsAffected ?? 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function mergeSourceObservation(db: Db, input: MergeInput): Promise<MergeResult> {
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

	// 1. normalize identifiers + fields, partition links by URL allowlist
	const normIds = (input.identifiers ?? []).map((i) => normalizeIdentifier(i));
	const cleanFields = normalizeFields(input.fields);
	const { safe: safeLinks, unsafe: unsafeLinks } = partitionLinks(input.links);
	for (const u of unsafeLinks) {
		rejectedClaims.push({
			fieldName: 'links',
			op: 'add',
			status: 'rejected',
			reason: `unsafe_url:${u.url}`
		});
	}

	// 2. payload hash (idempotency component)
	const payload: Record<string, unknown> = {
		fields: cleanFields,
		identifiers: normIds.map((i) => ({ kind: i.kind, valueNorm: i.valueNorm })),
		links: safeLinks,
		explicitDeletes: [...(input.explicitDeletes ?? [])].sort(),
		presence,
		lifecycle: input.lifecycle ?? null
	};
	const contentHash = hashPayload(payload);

	// 3. upsert observed_record (origin, originRecordId)
	await upsertObservedRecord(db, { origin, originRecordId, contentHash, nv, presence });

	// 4. insert observation idempotently — duplicate (origin,originRecordId,contentHash) ⇒ noop
	const [dup] = await db
		.select({ id: sourceObservations.id })
		.from(sourceObservations)
		.where(
			and(
				eq(sourceObservations.origin, origin),
				eq(sourceObservations.originRecordId, originRecordId),
				eq(sourceObservations.contentHash, contentHash)
			)
		)
		.limit(1);
	if (dup) {
		return {
			observationId: dup.id,
			status: 'noop',
			appliedClaims,
			heldClaims,
			rejectedClaims,
			conflicts,
			lifecycleEvents
		};
	}

	const observationId = uuid();
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
		matchDecision?: string
	): Promise<MergeResult> => {
		await db
			.update(sourceObservations)
			.set({ status: status === 'drift' ? 'noop' : status, matchDecision: matchDecision ?? null })
			.where(eq(sourceObservations.id, observationId));
		return {
			observationId,
			sourceId,
			status,
			appliedClaims,
			heldClaims,
			rejectedClaims,
			conflicts,
			lifecycleEvents
		};
	};

	// 5. audit gate (pre-identity, fatal) — rejected obs is KEPT in the ledger
	const fatal = auditIngest({ origin, derivation, confidence, evidence, identifiers: normIds, fields: cleanFields });
	if (fatal.length) {
		for (const f of fatal) {
			rejectedClaims.push({ fieldName: f.scope, op: 'set', status: 'rejected', reason: f.reason });
		}
		return finalize('rejected');
	}

	// 6. identity find-or-create
	const decision = await resolveIdentity(db, { identifiers: normIds, fields: cleanFields });

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
		sourceId = await createSourceRow(db, {
			fields: cleanFields,
			status: decision.status,
			origin,
			nv,
			candidate: decision.status === 'candidate'
		});
		createdNew = true;
		await writeLifecycleEvent(db, {
			sourceId,
			eventType: 'create',
			observationId,
			toStatus: decision.status,
			reason: `merge create (${decision.matchDecision})`,
			actor
		});
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

	// 9. per-field claims + band-rank + CAS apply
	const llm = auditLlmAssertions({ derivation, evidence, identifiers: normIds, fields: cleanFields });
	const explicitDeletes = new Set(input.explicitDeletes ?? []);
	const fieldsToProcess = new Set<string>([...Object.keys(cleanFields), ...explicitDeletes]);

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
			const out = await applySetUnion(db, sourceId, field, observationId, incoming, rank, meta);
			pushOutcome(field, 'add', out, rank, appliedClaims, heldClaims, conflicts);
			continue;
		}

		// existing winner (also used for the empty-overwrite guard)
		const prov = await readProvenance(db, sourceId, field);
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
		const out = await applyScalarCas(db, sourceId, field, claimId, rank, valueHash, meta);
		await setClaimStatus(db, claimId, out === 'applied' ? 'applied' : out === 'noop' ? 'applied' : out);
		pushOutcome(field, op, { outcome: out, valueHash }, rank, appliedClaims, heldClaims, conflicts);
	}

	// 10. set-union links (keeps existing IIIF / PDF / user links, never drops)
	if (safeLinks.length) {
		await mergeLinks(db, sourceId, safeLinks, observationId, { origin: normalizeOrigin(origin), derivation, confidence, evidence });
	}

	// 11. project winners → flat `sources`; recompute content hash
	await projectAndStore(db, sourceId, explicitDeletes);

	// 12. source_revisions row (history compat)
	await db.insert(sourceRevisions).values({
		sourceId,
		userId: actor,
		userName: actor,
		summary: `merge:${origin}:${decision.matchDecision}`,
		action: createdNew ? 'create' : 'update',
		snapshot: await buildSnapshot(db, sourceId)
	});

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
	return finalize(status, sourceId, decision.matchDecision);
}

// ---------------------------------------------------------------------------
// observed record
// ---------------------------------------------------------------------------

async function upsertObservedRecord(
	db: Db,
	args: { origin: string; originRecordId: string; contentHash: string; nv: number; presence: 'seen' | 'missing' }
): Promise<void> {
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
	const now = new Date();
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

async function createSourceRow(
	db: Db,
	args: { fields: Record<string, unknown>; status: 'active' | 'candidate'; origin: string; nv: number; candidate: boolean }
): Promise<string> {
	const id = uuid();
	const f = args.fields;
	const titleStr = typeof f.title === 'string' && f.title.trim() ? f.title : '(untitled)';
	const initType = typeof f.type === 'string' && ENUMS.type.has(f.type) ? f.type : 'other';
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
	await db.insert(sources).values({
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
	});
	return id;
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
	claimId: string,
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

/** Band-first CAS apply for a scalar/controlled/editorial/explicit_delete claim. */
async function applyScalarCas(
	db: Db,
	sourceId: string,
	field: string,
	claimId: string,
	rank: Rank,
	valueHash: string,
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): Promise<ScalarOutcome> {
	const editorial = rank.band === EDITORIAL_BAND;
	let prov = await readProvenance(db, sourceId, field);

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

/** set_union: merge with the existing winner; never drops a member. */
async function applySetUnion(
	db: Db,
	sourceId: string,
	field: string,
	observationId: string,
	incoming: string[],
	rank: Rank,
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): Promise<SetOutcome> {
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
		const merged = [...new Set([...existing, ...incoming])].sort();
		const valueHash = hashValue(merged);
		if (prov && prov.valueHash === valueHash) return { outcome: 'noop', valueHash };

		const claimId = await insertClaim(db, {
			observationId,
			sourceId,
			fieldName: field,
			value: merged,
			valueHash,
			op: 'add',
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
	let existing = '';
	if (prov?.currentClaimId) {
		const [c] = await db
			.select({ value: sourceFieldClaims.value })
			.from(sourceFieldClaims)
			.where(eq(sourceFieldClaims.id, prov.currentClaimId))
			.limit(1);
		if (typeof c?.value === 'string') existing = c.value;
	}
	if (!prov) {
		const valueHash = hashValue(incomingText);
		const claimId = await insertClaim(db, { observationId, sourceId, fieldName: field, value: incomingText, valueHash, op: 'set', rank, meta });
		const inserted = await casInsertFirst(db, sourceId, field, provWrite(claimId, valueHash, rank, meta));
		await setClaimStatus(db, claimId, 'applied');
		return { outcome: inserted ? 'applied' : 'applied', valueHash };
	}
	if (existing === incomingText || existing.includes(incomingText)) {
		return { outcome: 'noop', valueHash: prov.valueHash ?? '' };
	}
	const cur = { band: prov.rankBand ?? 0, score: prov.rankScore ?? 0 };
	const wins = rank.band > cur.band || (rank.band === cur.band && rank.score - cur.score > NEAR_SCORE_DELTA);
	const nextText = wins ? incomingText : `${existing}\n\n${incomingText}`;
	const valueHash = hashValue(nextText);
	const claimId = await insertClaim(db, { observationId, sourceId, fieldName: field, value: nextText, valueHash, op: wins ? 'set' : 'append', rank, meta });
	const ok = await casUpdate(db, sourceId, field, prov.currentClaimId, provWrite(claimId, valueHash, rank, meta));
	await setClaimStatus(db, claimId, ok ? 'applied' : 'superseded');
	return { outcome: ok ? 'applied' : 'held_below', valueHash };
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
	meta: { origin: string; derivation: string; confidence: number; evidence: number }
): Promise<void> {
	const existing = await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId));
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

async function projectAndStore(db: Db, sourceId: string, explicitDeletes: Set<string>): Promise<void> {
	// Read the winning claim value for every (source, field) via provenance:
	// provenance.currentClaimId points at the single winning claim per field.
	const winners = await db
		.select({ field: sourceFieldClaims.fieldName, value: sourceFieldClaims.value })
		.from(sourceFieldProvenance)
		.innerJoin(sourceFieldClaims, eq(sourceFieldProvenance.currentClaimId, sourceFieldClaims.id))
		.where(eq(sourceFieldProvenance.sourceId, sourceId));

	const upd: Record<string, unknown> = {};
	for (const r of winners) {
		if (!CLAIMABLE.has(r.field)) continue;
		upd[r.field] = r.value;
	}
	for (const f of explicitDeletes) if (CLAIMABLE.has(f)) upd[f] = null;
	upd.updatedAt = new Date();
	upd.lastSeenAt = new Date();
	if (Object.keys(upd).length) {
		await db.update(sources).set(upd).where(eq(sources.id, sourceId));
	}
	await recomputeContentHash(db, sourceId);
}

async function recomputeContentHash(db: Db, sourceId: string): Promise<void> {
	const [src] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
	if (!src) return;
	const links = await db
		.select()
		.from(sourceLinks)
		.where(and(eq(sourceLinks.sourceId, sourceId), eq(sourceLinks.status, 'active')));
	const tagRows = await db
		.select({ name: tags.name })
		.from(sourceTags)
		.innerJoin(tags, eq(sourceTags.tagId, tags.id))
		.where(eq(sourceTags.sourceId, sourceId));
	const personRows = await db
		.select({ slug: persons.slug, role: sourcePersons.role, sortOrder: sourcePersons.sortOrder })
		.from(sourcePersons)
		.innerJoin(persons, eq(sourcePersons.personId, persons.id))
		.where(eq(sourcePersons.sourceId, sourceId));
	const placeRows = await db
		.select({ slug: places.slug, role: sourcePlaces.role, notes: sourcePlaces.notes })
		.from(sourcePlaces)
		.innerJoin(places, eq(sourcePlaces.placeId, places.id))
		.where(eq(sourcePlaces.sourceId, sourceId));
	const instRows = await db
		.select({ slug: institutions.slug, role: sourceInstitutions.role, callNumber: sourceInstitutions.callNumber, notes: sourceInstitutions.notes })
		.from(sourceInstitutions)
		.innerJoin(institutions, eq(sourceInstitutions.institutionId, institutions.id))
		.where(eq(sourceInstitutions.sourceId, sourceId));
	const relOut = await db
		.select({ to: sourceRelations.toSourceId, type: sourceRelations.type })
		.from(sourceRelations)
		.where(eq(sourceRelations.fromSourceId, sourceId));
	const relIn = await db
		.select({ from: sourceRelations.fromSourceId, type: sourceRelations.type })
		.from(sourceRelations)
		.where(eq(sourceRelations.toSourceId, sourceId));
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
	const projection = projectSource({
		source: src as unknown as Record<string, unknown>,
		links,
		tags: tagRows.map((t) => t.name),
		persons: personRows,
		places: placeRows,
		institutions: instRows,
		relations
	});
	const hash = hashProjection(projection);
	if (src.contentHash !== hash) {
		await db.update(sources).set({ contentHash: hash, contentChangedAt: new Date() }).where(eq(sources.id, sourceId));
	} else {
		await db.update(sources).set({ contentHash: hash }).where(eq(sources.id, sourceId));
	}
}

// ---------------------------------------------------------------------------
// revision snapshot
// ---------------------------------------------------------------------------

async function buildSnapshot(db: Db, sourceId: string): Promise<Record<string, unknown>> {
	const [src] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
	if (!src) return {};
	const links = await db.select().from(sourceLinks).where(eq(sourceLinks.sourceId, sourceId));
	const tagRows = await db
		.select({ name: tags.name })
		.from(sourceTags)
		.innerJoin(tags, eq(sourceTags.tagId, tags.id))
		.where(eq(sourceTags.sourceId, sourceId));
	return { source: src, links, tags: tagRows.map((t) => t.name) };
}
