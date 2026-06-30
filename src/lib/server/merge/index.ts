/**
 * Provenance-aware merge engine — barrel export.
 *
 * The single idempotent entry point all writers will eventually route through:
 *   mergeSourceObservation(db, input): Promise<MergeResult>
 *
 * Standalone in Phase 4: NOT yet wired into any route, the Worker, or the
 * website. Pure code + CAS over the Phase-2 ledger tables.
 */
export {
	mergeSourceObservation,
	planSourceObservation,
	commitMerge,
	openChangeRequest,
	reviewChangeRequest,
	applyChangeRequest,
	recoverStuckApplyingChangeRequests,
	ChangeRequestStale,
	type CommitOptions
} from './merge-source-observation';
export {
	decideChangeGate,
	type GateDecision,
	type GateMode,
	type ChangeKind,
	type MergePlan,
	type PlannedFieldOutcome
} from './decision';
export type {
	Db,
	MergeInput,
	MergeResult,
	ProposedMergeResult,
	ReviewInput,
	ReviewResult,
	IdentifierInput,
	LinkInput,
	LifecycleInput,
	ClaimOutcome,
	ConflictOutcome,
	LifecycleOutcome
} from './types';

export { NORMALIZER_VERSION, EDITORIAL_ORIGINS, STRONG_ID_KINDS } from './constants';
export { hashValue, hashPayload, canonicalStringify, sha256Hex } from './hash';
export {
	normalizeIdentifier,
	normalizeText,
	normalizeProse,
	normalizeStringArray,
	normalizeFields,
	canonicalizeUrl,
	coreText,
	isEmptyValue,
	type NormalizedIdentifier
} from './normalize';
export { allowUrl, partitionLinks, safeUrl } from './url-allow';
export {
	DERIVATION_BANDS,
	EDITORIAL_BAND,
	LEGACY_ORIGIN_MAP,
	normalizeOrigin,
	originWeight,
	derivationBand,
	computeScore,
	rankOf,
	compareRank,
	NEAR_SCORE_DELTA,
	type Rank
} from './rank';
export {
	FIELD_POLICIES,
	ENUMS,
	CLAIMABLE_FIELDS,
	SUBSTANTIVE_FIELDS,
	policyFor,
	type FieldPolicy,
	type PolicyKind
} from './field-policies';
export {
	auditIngest,
	auditCreation,
	auditLlmAssertions,
	isEmptyOverwrite
} from './audit-gate';
export { resolveIdentity, matchHash, type IdentityDecision } from './identity';
export {
	readProvenance,
	casInsertFirst,
	casUpdate,
	CAS_MAX_RETRY,
	type ProvenanceRow,
	type ProvenanceWrite
} from './cas';
export { writeLifecycleEvent, applyLifecycleOp, softMerge } from './lifecycle';
