/**
 * LLM reviewer (Git-in-the-DB Phase 6) — the "previewed by LLMs" gate.
 *
 * The LLM is a **non-actor-privileged** reviewer: it decides WHETHER an already
 * band-ranked, already-proposed change may apply — it NEVER changes a claim's
 * band / score / value, NEVER asserts strong identifiers, and NEVER sets
 * evidence-required fields. Its verdict is ADVISORY by default; auto-apply is
 * gated behind the `SOURCES_LLM_AUTOAPPROVE` env flag AND a conservative
 * safe-enrichment predicate (see {@link isSafeEnrichment} in the Phase-6 §2
 * block below). This mirrors the actor-agnostic `rank.ts`: a review gates
 * application, it never confers authority.
 *
 * This module has three halves:
 *   • {@link buildLlmReviewContext} — assemble the §5 `LlmReviewContext` from the
 *     durable ledger (the change request, its SourceDiff, the observation payload
 *     + match decision, the source's current per-field provenance, and the rules
 *     block). PURE READS.
 *   • {@link callLlmReviewer} — call the (INJECTABLE) reviewer and STRICTLY
 *     validate its response into an {@link LlmReviewOutput}, rejecting the whole
 *     review on any schema violation. The default client is a `fetch`-based
 *     Anthropic Messages API call (model `claude-sonnet-4-6`, forced tool call
 *     for structured output); tests inject a fake and never hit the network.
 *   • {@link reviewProposalWithLLM} (Phase-6 §2, below) — orchestrate build →
 *     call → record (advisory) → optional safe-enrichment auto-apply.
 *
 * No `db.transaction()` anywhere; recording + apply go through the Phase-4
 * `reviewChangeRequest` / `applyChangeRequest` (single statements / `db.batch`).
 */
import { env } from '$env/dynamic/private';
import type { Db } from './types';
import type { SourceDiff } from './diff';
import type { ChangeKind } from './decision';
import { getChangeRequestDetail, type CurrentProvenanceRow } from '../review-queue';
import { LLM_RESTRICTED_FIELDS } from './audit-gate';

// ---------------------------------------------------------------------------
// §5 — the reviewer interface
// ---------------------------------------------------------------------------

/** The model the reviewer runs on, and the `reviewerActor` recorded on the review. */
export const LLM_REVIEWER_MODEL = 'claude-sonnet-4-6';

/**
 * Everything the reviewer is GIVEN (§5). Assembled from the durable ledger; the
 * reviewer sees the proposed diff, the raw evidence, and how the proposal
 * compares to what is already there — never any write capability.
 */
export interface LlmReviewContext {
	changeRequest: {
		id: string;
		kind: ChangeKind;
		routingReason: string;
		origin: string;
		originRecordId: string;
		derivation: string;
		confidence: number;
		evidence: number;
	};
	/** the stored before→after preview incl. summaryLines + held/rejected (with reasons) */
	diff: SourceDiff;
	observation: {
		payload: Record<string, unknown>;
		rawPayload: Record<string, unknown> | null;
		contentHash: string;
		matchDecision: string | null;
	};
	/** the attached source's CURRENT winning provenance per field — is the proposal
	 *  better-sourced than what's already there? (empty for a brand-new source) */
	currentProvenance: CurrentProvenanceRow[];
	/** the non-negotiable rules the reviewer operates under (mirrors audit-gate.ts) */
	rules: {
		noFabrication: true;
		noHardDeletes: true;
		llmCannotAssertStrongIdentifiers: true;
		/** holdingInstitution / callNumber / yearStart / yearEnd */
		llmCannotSetWithoutEvidence: string[];
		reviewerVerdictDoesNotChangeRank: true;
		confidenceRange: [0, 1];
	};
}

/**
 * Everything the reviewer RETURNS (§5) — STRICTLY validated before it is recorded.
 * A schema violation rejects the WHOLE review ({@link LlmReviewSchemaError}); a
 * malformed reviewer response never lands in the ledger.
 */
export interface LlmReviewOutput {
	verdict: 'apply' | 'reject' | 'needs_evidence';
	/** the reviewer's self-reported confidence in [0,1] — advisory only, never rank */
	confidence: number;
	reason: string;
	evidenceRefs?: string[];
	/** advisory per-field notes (v1 does not enforce them — whole-CR verdict only) */
	fieldNotes?: Array<{ field: string; verdict: 'apply' | 'reject' | 'needs_evidence'; reason: string }>;
}

/** The valid verdicts, shared by the whole-CR verdict and the advisory fieldNotes. */
const VERDICTS = new Set(['apply', 'reject', 'needs_evidence']);

/**
 * The INJECTABLE reviewer transport: given a context, return the model's RAW
 * (unvalidated) structured response. Tests pass a fake; the default is the
 * `fetch`-based Anthropic client. Kept deliberately narrow so a fake is a
 * one-liner and never needs the network.
 */
export type LlmReviewClient = (
	context: LlmReviewContext,
	signal?: AbortSignal
) => Promise<unknown>;

export interface CallLlmReviewerOptions {
	/** inject a fake reviewer (tests). When set, `apiKey`/`model`/`fetchImpl` are ignored. */
	client?: LlmReviewClient;
	/** override the Anthropic API key (default: `env.ANTHROPIC_API_KEY`). */
	apiKey?: string;
	/** override the model (default: {@link LLM_REVIEWER_MODEL}). */
	model?: string;
	/** inject a `fetch` implementation (tests / non-DOM runtimes). */
	fetchImpl?: typeof fetch;
	/** abort the outbound request. */
	signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Context builder — PURE READS off the durable ledger
// ---------------------------------------------------------------------------

/**
 * Assemble the §5 {@link LlmReviewContext} for a change request. Reuses the
 * Phase-5 read model ({@link getChangeRequestDetail}) — one bounded set of reads,
 * no per-row fan-out — and shapes it into the reviewer contract. Throws when the
 * change request, its observation, or its `proposal` diff is missing (a proposal
 * always writes all three, so a missing one is a real integrity error).
 */
export async function buildLlmReviewContext(db: Db, crId: string): Promise<LlmReviewContext> {
	const detail = await getChangeRequestDetail(db, crId);
	if (!detail) throw new Error(`change request ${crId} not found`);
	if (!detail.observation) throw new Error(`change request ${crId} has no observation`);
	if (!detail.diff) throw new Error(`change request ${crId} has no proposal diff`);

	const cr = detail.changeRequest;
	return {
		changeRequest: {
			id: cr.id,
			kind: cr.kind as ChangeKind,
			routingReason: cr.routingReason,
			origin: cr.origin,
			originRecordId: cr.originRecordId,
			derivation: cr.derivation,
			confidence: cr.confidence,
			evidence: cr.evidence
		},
		diff: detail.diff,
		observation: {
			payload: detail.observation.payload ?? {},
			rawPayload: detail.observation.rawPayload,
			contentHash: detail.observation.contentHash,
			matchDecision: detail.observation.matchDecision
		},
		currentProvenance: detail.currentProvenance,
		rules: {
			noFabrication: true,
			noHardDeletes: true,
			llmCannotAssertStrongIdentifiers: true,
			llmCannotSetWithoutEvidence: [...LLM_RESTRICTED_FIELDS],
			reviewerVerdictDoesNotChangeRank: true,
			confidenceRange: [0, 1]
		}
	};
}

// ---------------------------------------------------------------------------
// Strict output validation — reject the WHOLE review on any schema violation
// ---------------------------------------------------------------------------

/** A reviewer response that violated the {@link LlmReviewOutput} schema. */
export class LlmReviewSchemaError extends Error {
	readonly code = 'llm_review_schema_violation';
	constructor(message: string) {
		super(message);
		this.name = 'LlmReviewSchemaError';
	}
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * STRICTLY validate a raw reviewer response into an {@link LlmReviewOutput}.
 * Every field is checked; ANY violation throws {@link LlmReviewSchemaError} so the
 * whole review is rejected (never partially recorded). Unknown extra keys are
 * ignored (forward-compatible), but every declared field must be well-typed.
 */
export function validateLlmReviewOutput(raw: unknown): LlmReviewOutput {
	if (!isRecord(raw)) throw new LlmReviewSchemaError('review response is not an object');

	const verdict = raw.verdict;
	if (typeof verdict !== 'string' || !VERDICTS.has(verdict))
		throw new LlmReviewSchemaError(`invalid verdict: ${JSON.stringify(verdict)}`);

	const confidence = raw.confidence;
	if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
		throw new LlmReviewSchemaError(`confidence out of range [0,1]: ${JSON.stringify(confidence)}`);

	const reason = raw.reason;
	if (typeof reason !== 'string' || reason.trim() === '')
		throw new LlmReviewSchemaError('reason must be a non-empty string');

	let evidenceRefs: string[] | undefined;
	if (raw.evidenceRefs !== undefined) {
		if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.some((r) => typeof r !== 'string'))
			throw new LlmReviewSchemaError('evidenceRefs must be an array of strings');
		evidenceRefs = raw.evidenceRefs as string[];
	}

	let fieldNotes: LlmReviewOutput['fieldNotes'];
	if (raw.fieldNotes !== undefined) {
		if (!Array.isArray(raw.fieldNotes))
			throw new LlmReviewSchemaError('fieldNotes must be an array');
		fieldNotes = raw.fieldNotes.map((n, i) => {
			if (!isRecord(n)) throw new LlmReviewSchemaError(`fieldNotes[${i}] is not an object`);
			if (typeof n.field !== 'string' || n.field.trim() === '')
				throw new LlmReviewSchemaError(`fieldNotes[${i}].field must be a non-empty string`);
			if (typeof n.verdict !== 'string' || !VERDICTS.has(n.verdict))
				throw new LlmReviewSchemaError(`fieldNotes[${i}].verdict invalid`);
			if (typeof n.reason !== 'string' || n.reason.trim() === '')
				throw new LlmReviewSchemaError(`fieldNotes[${i}].reason must be a non-empty string`);
			return {
				field: n.field,
				verdict: n.verdict as LlmReviewOutput['verdict'],
				reason: n.reason
			};
		});
	}

	return { verdict: verdict as LlmReviewOutput['verdict'], confidence, reason, evidenceRefs, fieldNotes };
}

// ---------------------------------------------------------------------------
// The reviewer call — injectable client + strict validation
// ---------------------------------------------------------------------------

/**
 * Run the reviewer over a context and return a validated {@link LlmReviewOutput}.
 * The client is INJECTABLE ({@link CallLlmReviewerOptions.client}); by default it
 * is the `fetch`-based Anthropic Messages API call. The raw response is ALWAYS run
 * through {@link validateLlmReviewOutput}, so a malformed model response rejects
 * the whole review rather than corrupting the ledger.
 */
export async function callLlmReviewer(
	context: LlmReviewContext,
	opts?: CallLlmReviewerOptions
): Promise<LlmReviewOutput> {
	const client =
		opts?.client ??
		anthropicReviewClient({ apiKey: opts?.apiKey, model: opts?.model, fetchImpl: opts?.fetchImpl });
	const raw = await client(context, opts?.signal);
	return validateLlmReviewOutput(raw);
}

// ---------------------------------------------------------------------------
// Default reviewer client — Anthropic Messages API over `fetch`
// ---------------------------------------------------------------------------

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const REVIEW_TOOL_NAME = 'record_review';

/** The forced structured-output tool: the model MUST call it with the verdict. */
const REVIEW_TOOL = {
	name: REVIEW_TOOL_NAME,
	description:
		'Record your advisory review verdict for this proposed change request. ' +
		'You are a non-privileged reviewer: you decide only WHETHER the already-ranked ' +
		'proposed values should apply — you never change a value, band, or rank.',
	input_schema: {
		type: 'object',
		additionalProperties: false,
		properties: {
			verdict: {
				type: 'string',
				enum: ['apply', 'reject', 'needs_evidence'],
				description:
					"'apply' if the change is well-sourced and should land; 'needs_evidence' if it " +
					"is plausible but under-evidenced; 'reject' if it contradicts better-sourced data or fabricates."
			},
			confidence: {
				type: 'number',
				description: 'Your confidence in this verdict, a number from 0 to 1.'
			},
			reason: { type: 'string', description: 'A concise justification grounded in the diff and evidence.' },
			evidenceRefs: {
				type: 'array',
				items: { type: 'string' },
				description: 'Optional references (URLs, identifiers) supporting the verdict.'
			},
			fieldNotes: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						field: { type: 'string' },
						verdict: { type: 'string', enum: ['apply', 'reject', 'needs_evidence'] },
						reason: { type: 'string' }
					},
					required: ['field', 'verdict', 'reason']
				},
				description: 'Optional advisory per-field notes.'
			}
		},
		required: ['verdict', 'confidence', 'reason']
	},
	strict: true
} as const;

const REVIEW_SYSTEM_PROMPT = [
	'You are an advisory reviewer for a scholarly Ainu-language source catalogue.',
	'A "change request" is a PROPOSED edit to a source record that has already been',
	'normalized, audited, band-ranked, and identity-matched by a deterministic engine.',
	'',
	'Your ONLY job is to decide whether the already-ranked proposed values should apply.',
	'Hard rules — you operate strictly inside them:',
	'  • No fabrication. Ground every judgement in the provided diff, payload, and evidence.',
	'  • You NEVER change a value, band, score, or rank. You only gate whether it applies.',
	'  • You CANNOT assert strong identifiers (DOI/ISBN/ISSN/OpenAlex/CiNii/NDL/J-Stage).',
	'  • You CANNOT set evidence-required fields (holdingInstitution, callNumber, yearStart,',
	'    yearEnd) unless the observation already carries evidence.',
	'  • There are no hard deletes; a removal is a status change, not data loss.',
	'',
	'Compare the proposal to the source\'s current per-field provenance: is it better-sourced,',
	'consistent, and non-fabricated? Return your verdict via the record_review tool only.'
].join('\n');

/** Serialize the context into a compact, deterministic user prompt for the model. */
function buildReviewUserPrompt(context: LlmReviewContext): string {
	const payload = {
		changeRequest: context.changeRequest,
		rules: context.rules,
		observation: {
			matchDecision: context.observation.matchDecision,
			contentHash: context.observation.contentHash,
			payload: context.observation.payload,
			rawPayload: context.observation.rawPayload
		},
		diff: {
			isNewSource: context.diff.isNewSource,
			summaryLines: context.diff.summaryLines,
			scalars: context.diff.scalars,
			changedCollections: context.diff.changedCollections,
			conflicts: context.diff.conflicts,
			heldClaims: context.diff.heldClaims,
			rejectedClaims: context.diff.rejectedClaims,
			warnings: context.diff.warnings
		},
		currentProvenance: context.currentProvenance
	};
	return (
		'Review this proposed change request and record your verdict.\n\n' +
		'```json\n' +
		JSON.stringify(payload, null, 2) +
		'\n```'
	);
}

/**
 * The default reviewer transport: one `fetch` POST to the Anthropic Messages API,
 * forcing the {@link REVIEW_TOOL} tool call so the response is structured, then
 * returning the raw tool input for {@link validateLlmReviewOutput}. Reads the API
 * key from `env.ANTHROPIC_API_KEY` unless overridden. NEVER used in tests (they
 * inject a fake client).
 */
export function anthropicReviewClient(cfg?: {
	apiKey?: string;
	model?: string;
	fetchImpl?: typeof fetch;
}): LlmReviewClient {
	return async (context, signal) => {
		const apiKey = cfg?.apiKey ?? env.ANTHROPIC_API_KEY;
		if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set (LLM reviewer)');
		const model = cfg?.model ?? LLM_REVIEWER_MODEL;
		const doFetch = cfg?.fetchImpl ?? fetch;

		const res = await doFetch(ANTHROPIC_MESSAGES_URL, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': ANTHROPIC_VERSION
			},
			body: JSON.stringify({
				model,
				max_tokens: 1024,
				system: REVIEW_SYSTEM_PROMPT,
				tools: [REVIEW_TOOL],
				tool_choice: { type: 'tool', name: REVIEW_TOOL_NAME },
				messages: [{ role: 'user', content: buildReviewUserPrompt(context) }]
			}),
			signal
		});

		if (!res.ok) {
			const text = await res.text().catch(() => '');
			throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 500)}`);
		}
		const data = (await res.json()) as { content?: Array<{ type?: string; name?: string; input?: unknown }> };
		const block = (data.content ?? []).find(
			(b) => b?.type === 'tool_use' && b?.name === REVIEW_TOOL_NAME
		);
		if (!block) throw new Error('Anthropic response did not contain a record_review tool call');
		return block.input;
	};
}
