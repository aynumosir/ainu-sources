/**
 * Audit gate (§2 step 6) — reject WITHOUT losing.
 *
 * A rejected observation is still recorded in the ledger (status='rejected');
 * the gate only prevents a bad payload from MUTATING canonical data. Checks are
 * exposed as small pure predicates so the orchestrator can run them at the right
 * pipeline stage (some are pre-identity fatal, some are per-field, one is a
 * create-time gate that needs the identity decision).
 */
import { EDITORIAL_ORIGINS, STRONG_ID_KINDS } from './constants';
import type { NormalizedIdentifier } from './normalize';
import { isEmptyValue } from './normalize';

export interface AuditFinding {
	/** observation-level reason if `fatal`, else the offending field */
	scope: 'observation' | string;
	reason: string;
}

/** Low-trust derivations that MUST carry evidence (>0) to mutate anything. */
const EVIDENCE_REQUIRED = new Set(['llm_extraction', 'inferred', 'heuristic']);

/** Fields an LLM may not assert without evidence (ids handled separately).
 *  Exported so the Phase-6 LLM reviewer can surface the SAME evidence-required
 *  field list in its review context (`rules.llmCannotSetWithoutEvidence`) and
 *  mirror the gate in its safe-enrichment predicate. */
export const LLM_RESTRICTED_FIELDS = new Set([
	'holdingInstitution',
	'callNumber',
	'yearStart',
	'yearEnd'
]);

/**
 * Pre-identity fatal checks. Any finding rejects the whole observation.
 * Returns the list of fatal findings (empty ⇒ pass).
 */
export function auditIngest(input: {
	origin: string;
	derivation: string;
	confidence: number;
	evidence: number;
	identifiers: NormalizedIdentifier[];
	fields: Record<string, unknown>;
}): AuditFinding[] {
	const findings: AuditFinding[] = [];

	// confidence ∈ [0,1]
	if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
		findings.push({ scope: 'observation', reason: `confidence_out_of_range:${input.confidence}` });
	}

	// malformed DOI / ISBN / ISSN / OpenAlex (any invalid identifier)
	for (const id of input.identifiers) {
		if (!id.valid) {
			findings.push({ scope: 'observation', reason: `malformed_identifier:${id.kind}:${id.valueRaw}` });
		}
	}

	// derived / inferred / LLM without evidence
	if (EVIDENCE_REQUIRED.has(input.derivation) && (input.evidence ?? 0) <= 0) {
		findings.push({
			scope: 'observation',
			reason: `evidence_required_for_derivation:${input.derivation}`
		});
	}

	// editorial_decision forbidden for harvester / LLM origins
	if (input.derivation === 'editorial_decision' && !EDITORIAL_ORIGINS.has(input.origin)) {
		findings.push({
			scope: 'observation',
			reason: `editorial_decision_forbidden_for_origin:${input.origin}`
		});
	}

	return findings;
}

/**
 * LLM-specific per-field rejections. An LLM extraction may NEVER assert strong
 * identifiers, and may not set holding/call-number/exact-year fields unless it
 * carries evidence. Returns the field names to drop (kept out of the projection,
 * recorded as rejected claims).
 */
export function auditLlmAssertions(input: {
	derivation: string;
	evidence: number;
	identifiers: NormalizedIdentifier[];
	fields: Record<string, unknown>;
}): { rejectedFields: string[]; rejectStrongIds: boolean } {
	if (input.derivation !== 'llm_extraction') {
		return { rejectedFields: [], rejectStrongIds: false };
	}
	const rejectStrongIds = input.identifiers.some((i) => STRONG_ID_KINDS.has(i.kind));
	const rejectedFields: string[] = [];
	if ((input.evidence ?? 0) <= 0) {
		for (const f of Object.keys(input.fields)) {
			if (LLM_RESTRICTED_FIELDS.has(f) && !isEmptyValue(input.fields[f])) rejectedFields.push(f);
		}
	}
	return { rejectedFields, rejectStrongIds };
}

/** Create-time gate: a NEW source needs a title OR a strong identifier. */
export function auditCreation(ctx: { hasTitle: boolean; hasStrongId: boolean }): AuditFinding | null {
	if (!ctx.hasTitle && !ctx.hasStrongId) {
		return { scope: 'observation', reason: 'no_title_and_no_strong_id' };
	}
	return null;
}

/**
 * Per-field empty-overwrite guard. An empty incoming value may not clobber an
 * existing non-empty value UNLESS it is an explicit delete. Returns true when
 * the claim must be rejected.
 */
export function isEmptyOverwrite(ctx: {
	incomingValue: unknown;
	hasExistingNonEmpty: boolean;
	isExplicitDelete: boolean;
}): boolean {
	return (
		!ctx.isExplicitDelete && isEmptyValue(ctx.incomingValue) && ctx.hasExistingNonEmpty
	);
}
