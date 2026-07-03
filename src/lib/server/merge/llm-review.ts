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
import type { Db, ReviewResult } from './types';
import type { SourceDiff } from './diff';
import { STRONG_ATTACH, type ChangeKind } from './decision';
import { getChangeRequestDetail, type CurrentProvenanceRow } from '../review-queue';
import { LLM_RESTRICTED_FIELDS, auditLlmAssertions } from './audit-gate';
import { reviewChangeRequest, applyChangeRequest, ChangeRequestStale } from './merge-source-observation';

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

/** Which LLM backend the default reviewer transport hits. */
export type LlmProvider = 'anthropic' | 'openrouter';

/**
 * Per-call token usage captured off the provider response, so a batch run can
 * total the REAL cost. `costUsd` is populated only when the provider reports it
 * (OpenRouter with `usage: { include: true }` returns an actual `usage.cost`);
 * Anthropic reports tokens only.
 */
export interface LlmUsage {
	model: string;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** actual USD cost when the provider reports it (OpenRouter `usage.cost`). */
	costUsd?: number;
}

export interface CallLlmReviewerOptions {
	/** inject a fake reviewer (tests). When set, provider/`apiKey`/`model`/`fetchImpl` are ignored. */
	client?: LlmReviewClient;
	/** pick the backend (default: `env.LLM_PROVIDER` → `anthropic`). */
	provider?: LlmProvider;
	/** override the API key (default: the provider's env key). */
	apiKey?: string;
	/** override the model (default: `env.LLM_MODEL` → {@link LLM_REVIEWER_MODEL}). */
	model?: string;
	/** inject a `fetch` implementation (tests / non-DOM runtimes). */
	fetchImpl?: typeof fetch;
	/** abort the outbound request. */
	signal?: AbortSignal;
	/** capture per-call token usage / cost off the provider response. */
	onUsage?: (usage: LlmUsage) => void;
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
	const client = opts?.client ?? defaultReviewClient(opts);
	const raw = await client(context, opts?.signal);
	return validateLlmReviewOutput(raw);
}

/** Resolve the default reviewer transport for the configured provider. The
 *  provider comes from `opts.provider`, else `env.LLM_PROVIDER`, else `anthropic`
 *  (unchanged default) — so the Anthropic path stays byte-identical unless a
 *  caller opts into OpenRouter. Usage capture is threaded through `onUsage`. */
export function defaultReviewClient(opts?: CallLlmReviewerOptions): LlmReviewClient {
	const provider = (opts?.provider ?? env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as LlmProvider;
	const cfg = {
		apiKey: opts?.apiKey,
		model: opts?.model,
		fetchImpl: opts?.fetchImpl,
		onUsage: opts?.onUsage
	};
	return provider === 'openrouter' ? openrouterReviewClient(cfg) : anthropicReviewClient(cfg);
}

// ---------------------------------------------------------------------------
// Default reviewer client — Anthropic Messages API over `fetch`
// ---------------------------------------------------------------------------

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const REVIEW_TOOL_NAME = 'record_review';
const REVIEW_TOOL_DESCRIPTION =
	'Record your advisory review verdict for this proposed change request. ' +
	'You are a non-privileged reviewer: you decide only WHETHER the already-ranked ' +
	'proposed values should apply — you never change a value, band, or rank.';

/** The record_review JSON schema — SHARED by the Anthropic (`input_schema`) and the
 *  OpenAI/OpenRouter (`function.parameters`) tool shapes, so both providers force the
 *  SAME structured output that {@link validateLlmReviewOutput} then strictly checks. */
const REVIEW_TOOL_SCHEMA = {
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
} as const;

/** Anthropic Messages API tool shape (forced structured output). */
const REVIEW_TOOL = {
	name: REVIEW_TOOL_NAME,
	description: REVIEW_TOOL_DESCRIPTION,
	input_schema: REVIEW_TOOL_SCHEMA,
	strict: true
} as const;

/** OpenAI-compatible (OpenRouter) function-tool shape — same schema, chat wire format. */
const REVIEW_TOOL_OPENAI = {
	type: 'function',
	function: {
		name: REVIEW_TOOL_NAME,
		description: REVIEW_TOOL_DESCRIPTION,
		parameters: REVIEW_TOOL_SCHEMA
	}
} as const;

/** The record_review key contract, restated for the JSON-mode fallback (models that
 *  ignore forced tool calls) so the raw response still parses + validates. */
const REVIEW_JSON_INSTRUCTION =
	'Respond with ONLY a single JSON object (no markdown, no prose) with keys: ' +
	'"verdict" (one of "apply", "reject", "needs_evidence"), "confidence" (a number 0..1), ' +
	'"reason" (a non-empty string), and optionally "evidenceRefs" (array of strings).';

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
	onUsage?: (usage: LlmUsage) => void;
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
		const data = (await res.json()) as {
			content?: Array<{ type?: string; name?: string; input?: unknown }>;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		if (data.usage && cfg?.onUsage) {
			const inTok = Number(data.usage.input_tokens ?? 0);
			const outTok = Number(data.usage.output_tokens ?? 0);
			cfg.onUsage({ model, promptTokens: inTok, completionTokens: outTok, totalTokens: inTok + outTok });
		}
		const block = (data.content ?? []).find(
			(b) => b?.type === 'tool_use' && b?.name === REVIEW_TOOL_NAME
		);
		if (!block) throw new Error('Anthropic response did not contain a record_review tool call');
		return block.input;
	};
}

// ---------------------------------------------------------------------------
// OpenRouter reviewer client — OpenAI-compatible chat completions over `fetch`
// ---------------------------------------------------------------------------

/** Loosely parse a model's JSON output: trim, strip ``` / ```json fences, then
 *  fall back to extracting the first `{ … }` object. Returns `undefined` on
 *  failure so the caller can try the JSON-mode fallback rather than throwing. */
function tryParseJsonObject(text: string): unknown | undefined {
	const cleaned = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/```\s*$/i, '')
		.trim();
	try {
		return JSON.parse(cleaned);
	} catch {
		/* fall through */
	}
	const first = cleaned.indexOf('{');
	const last = cleaned.lastIndexOf('}');
	if (first !== -1 && last > first) {
		try {
			return JSON.parse(cleaned.slice(first, last + 1));
		} catch {
			/* give up */
		}
	}
	return undefined;
}

interface OpenAiChatResponse {
	model?: string;
	choices?: Array<{
		message?: {
			content?: string | null;
			tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
		};
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		cost?: number;
	};
}

/**
 * The OpenRouter reviewer transport: OpenAI-compatible `POST /chat/completions`
 * with `Authorization: Bearer <key>`, `usage: { include: true }` (so the response
 * carries the REAL `usage.cost`), and a low temperature. It forces the
 * {@link REVIEW_TOOL_OPENAI} `record_review` function call for structured output,
 * and — for models that ignore forced tool calls — FALLS BACK to a second request
 * with `response_format: { type: 'json_object' }`, parsing the raw JSON. Either way
 * the RAW object is returned for {@link validateLlmReviewOutput} to strictly check.
 *
 * Reads the key from `env.OPENROUTER_API_KEY` and the model from `env.LLM_MODEL`
 * (→ {@link LLM_REVIEWER_MODEL}) unless overridden. NEVER used in tests (they inject
 * a fake client).
 */
export function openrouterReviewClient(cfg?: {
	apiKey?: string;
	model?: string;
	fetchImpl?: typeof fetch;
	onUsage?: (usage: LlmUsage) => void;
}): LlmReviewClient {
	return async (context, signal) => {
		const apiKey = cfg?.apiKey ?? env.OPENROUTER_API_KEY;
		if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set (LLM reviewer)');
		const model = cfg?.model ?? env.LLM_MODEL ?? LLM_REVIEWER_MODEL;
		const doFetch = cfg?.fetchImpl ?? fetch;
		const headers = {
			'content-type': 'application/json',
			authorization: `Bearer ${apiKey}`,
			// OpenRouter attribution headers (optional, best-effort).
			'HTTP-Referer': 'https://db.aynu.org',
			'X-Title': 'ainu-sources LLM reviewer'
		};
		const messages = [
			{ role: 'system', content: REVIEW_SYSTEM_PROMPT },
			{ role: 'user', content: buildReviewUserPrompt(context) }
		];

		const reportUsage = (data: OpenAiChatResponse) => {
			if (!data.usage || !cfg?.onUsage) return;
			const inTok = Number(data.usage.prompt_tokens ?? 0);
			const outTok = Number(data.usage.completion_tokens ?? 0);
			cfg.onUsage({
				model: data.model ?? model,
				promptTokens: inTok,
				completionTokens: outTok,
				totalTokens: Number(data.usage.total_tokens ?? inTok + outTok),
				costUsd: typeof data.usage.cost === 'number' ? data.usage.cost : undefined
			});
		};

		const post = async (body: Record<string, unknown>): Promise<OpenAiChatResponse> => {
			const res = await doFetch(OPENROUTER_URL, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model, temperature: 0, usage: { include: true }, ...body }),
				signal
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`OpenRouter API error ${res.status}: ${text.slice(0, 500)}`);
			}
			return (await res.json()) as OpenAiChatResponse;
		};

		// Attempt 1 — forced record_review tool call (structured output).
		const data = await post({
			messages,
			tools: [REVIEW_TOOL_OPENAI],
			tool_choice: { type: 'function', function: { name: REVIEW_TOOL_NAME } }
		});
		reportUsage(data);
		const msg = data.choices?.[0]?.message;
		const call =
			msg?.tool_calls?.find((t) => t.function?.name === REVIEW_TOOL_NAME) ?? msg?.tool_calls?.[0];
		if (call?.function?.arguments) {
			const parsed = tryParseJsonObject(call.function.arguments);
			if (parsed !== undefined) return parsed;
		}
		// some models emit the JSON inline in content instead of a tool call.
		if (typeof msg?.content === 'string' && msg.content.trim()) {
			const parsed = tryParseJsonObject(msg.content);
			if (parsed !== undefined) return parsed;
		}

		// Attempt 2 — JSON-mode fallback (no tools) for models that ignore tool_choice.
		const data2 = await post({
			messages: [
				{ role: 'system', content: `${REVIEW_SYSTEM_PROMPT}\n\n${REVIEW_JSON_INSTRUCTION}` },
				{ role: 'user', content: buildReviewUserPrompt(context) }
			],
			response_format: { type: 'json_object' }
		});
		reportUsage(data2);
		const content2 = data2.choices?.[0]?.message?.content;
		if (typeof content2 === 'string' && content2.trim()) {
			const parsed = tryParseJsonObject(content2);
			if (parsed !== undefined) return parsed;
		}
		throw new Error('OpenRouter response did not contain a parseable record_review result');
	};
}

// ---------------------------------------------------------------------------
// §2 — reviewProposalWithLLM + safe-enrichment auto-approve
// ---------------------------------------------------------------------------

/** The confidence floor (both the observation's OWN and the reviewer's OWN) that a
 *  safe-enrichment auto-apply requires. */
export const LLM_SAFE_CONFIDENCE = 0.85;

/** Is safe-enrichment auto-apply enabled? Reads the `SOURCES_LLM_AUTOAPPROVE` env
 *  flag fresh on every call (tests toggle it). DEFAULT OFF — while off, an LLM
 *  `apply` is purely advisory, and Phase-4 behavior is byte-identical. */
export function llmAutoApproveEnabled(): boolean {
	return env.SOURCES_LLM_AUTOAPPROVE === 'true';
}

/**
 * Would this proposal + verdict be auto-applied by an LLM `apply`? The
 * conservative safe-enrichment predicate — ALL must hold:
 *
 *   1. `kind === 'enrichment'`      — never a new source / conflict / lifecycle.
 *   2. clean attach                 — attaches to an EXISTING source (not new) via a
 *                                     strong/exact identity match ({@link STRONG_ATTACH}),
 *                                     NOT a fuzzy title match.
 *   3. no conflicts                 — the stored diff surfaced none.
 *   4. observation confidence ≥ 0.85 (the proposal's OWN confidence).
 *   5. reviewer confidence ≥ 0.85    (the LLM's OWN self-report).
 *   6. NOT a strong-identifier assertion, and NOT setting an evidence-required
 *      field without evidence — mirrors `audit-gate.ts` exactly
 *      ({@link auditLlmAssertions}), plus a belt-and-suspenders guard on the
 *      diff's changed fields for ANY derivation.
 *
 * Keys ONLY on `kind` / identity / confidence / conflicts / evidence — NEVER on the
 * actor — so it composes with the actor-agnostic `rank.ts`. Everything else (new
 * sources, conflicts, lifecycle, low-confidence, medium/fuzzy matches, strong-ID
 * changes) stays advisory-only.
 */
export function isSafeEnrichment(context: LlmReviewContext, output: LlmReviewOutput): boolean {
	if (output.verdict !== 'apply') return false;
	const cr = context.changeRequest;

	// 1. enrichment only.
	if (cr.kind !== 'enrichment') return false;

	// 2. clean attach: an existing source, strong/exact identity match.
	if (context.diff.isNewSource) return false;
	if (!context.diff.sourceId) return false;
	if (!STRONG_ATTACH.has(context.observation.matchDecision ?? '')) return false;

	// 3. no conflicts.
	if (context.diff.conflicts.length > 0) return false;

	// 4. + 5. confidence floors (proposal's own AND the reviewer's own).
	if (!(cr.confidence >= LLM_SAFE_CONFIDENCE)) return false;
	if (!(output.confidence >= LLM_SAFE_CONFIDENCE)) return false;

	// 6. not a strong-identifier assertion / evidence-required set without evidence.
	if (assertsStrongIdOrRestricted(context)) return false;
	if (setsEvidenceRequiredFieldWithoutEvidence(context)) return false;

	return true;
}

/** Mirror `audit-gate.ts`: would the engine's LLM-assertion audit reject this
 *  observation's strong identifiers or restricted fields? Reconstructs the
 *  observation's identifiers/fields from its normalized payload and runs the SAME
 *  {@link auditLlmAssertions} the merge engine runs. */
function assertsStrongIdOrRestricted(context: LlmReviewContext): boolean {
	const payload = context.observation.payload as {
		identifiers?: Array<{ kind?: string; valueNorm?: string }>;
		fields?: Record<string, unknown>;
	};
	const identifiers = (payload.identifiers ?? []).map((i) => ({ kind: String(i.kind ?? '') }));
	const fields = payload.fields ?? {};
	const audit = auditLlmAssertions({
		derivation: context.changeRequest.derivation,
		evidence: context.changeRequest.evidence,
		// auditLlmAssertions only reads `.kind`; a partial identifier is sufficient.
		identifiers: identifiers as never,
		fields
	});
	return audit.rejectStrongIds || audit.rejectedFields.length > 0;
}

/** Belt-and-suspenders (any derivation): if the CHANGED scalar fields include an
 *  evidence-required field and the observation carries no evidence, it is not safe
 *  to auto-apply — even for non-LLM derivations the audit gate does not restrict. */
function setsEvidenceRequiredFieldWithoutEvidence(context: LlmReviewContext): boolean {
	if (context.changeRequest.evidence > 0) return false;
	return context.diff.changedScalarFields.some((f) => LLM_RESTRICTED_FIELDS.has(f));
}

/** Turn a validated {@link LlmReviewOutput} into the plain JSON object recorded on
 *  the `change_request_reviews.payload` column (never a bare string). */
function outputToPayload(output: LlmReviewOutput): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		verdict: output.verdict,
		confidence: output.confidence,
		reason: output.reason
	};
	if (output.evidenceRefs) payload.evidenceRefs = output.evidenceRefs;
	if (output.fieldNotes) payload.fieldNotes = output.fieldNotes;
	return payload;
}

export interface ReviewProposalOptions extends CallLlmReviewerOptions {
	/** override the recorded reviewerActor (default: {@link LLM_REVIEWER_MODEL}). */
	actor?: string;
}

/** The outcome of {@link reviewProposalWithLLM}. */
export interface ReviewProposalResult {
	changeRequestId: string;
	/** the strictly-validated reviewer output. */
	output: LlmReviewOutput;
	/** the recorded review + resulting CR workflow status (from `reviewChangeRequest`). */
	review: ReviewResult;
	/** did {@link isSafeEnrichment} hold for this proposal + verdict? */
	safeEnrichment: boolean;
	/** did the safe-enrichment auto-apply actually run (flag ON + predicate + not stale)? */
	autoApplied: boolean;
}

/**
 * Phase-6 orchestrator: build the review context → run the (INJECTABLE) reviewer
 * (strictly validated) → RECORD the verdict as an advisory `change_request_reviews`
 * row via the Phase-4 {@link reviewChangeRequest} → optionally AUTO-APPLY when the
 * safe-enrichment predicate holds AND `SOURCES_LLM_AUTOAPPROVE` is on.
 *
 * Resolution policy (§5):
 *   • `reject` / `needs_evidence`  → recorded; `reviewChangeRequest` advances the CR
 *     (`needs_evidence`, or in v1 a hard LLM reject is left to that function's policy).
 *   • `apply` (ADVISORY, default)  → `reviewChangeRequest` marks the CR `approved`
 *     with ZERO canonical write (the LLM-advisory Phase-4 path, unchanged and
 *     byte-identical while the coarse `LLM_AUTOAPPROVE_CHANGE_REQUESTS` is off).
 *   • `apply` + `SOURCES_LLM_AUTOAPPROVE` on + {@link isSafeEnrichment} → we THEN
 *     drive {@link applyChangeRequest}, which re-plans live and commits through the
 *     ONE merge engine (no bypass). A live re-plan that turned conflicting bounces
 *     to `needs_evidence` ({@link ChangeRequestStale}) — advisory, never a clobber.
 *
 * The reviewer NEVER changes a claim's band / score / value; it only gates whether
 * an already-ranked proposed change applies. With the flag off, this function
 * records an advisory review and performs NO canonical write.
 */
export async function reviewProposalWithLLM(
	db: Db,
	crId: string,
	opts?: ReviewProposalOptions
): Promise<ReviewProposalResult> {
	const actor = opts?.actor ?? LLM_REVIEWER_MODEL;

	// build → call (strictly validated; a schema violation rejects the whole review).
	const context = await buildLlmReviewContext(db, crId);
	const output = await callLlmReviewer(context, opts);

	// record the verdict (advisory by default — reviewChangeRequest's LLM `apply`
	// branch marks the CR `approved` without touching canonical data).
	const review = await reviewChangeRequest(db, crId, {
		reviewerKind: 'llm',
		reviewerActor: actor,
		verdict: output.verdict,
		confidence: output.confidence,
		reason: output.reason,
		evidenceRefs: output.evidenceRefs,
		payload: outputToPayload(output)
	});

	// safe-enrichment auto-apply: ONLY when the flag is on AND the predicate holds.
	const safeEnrichment = isSafeEnrichment(context, output);
	let autoApplied = false;
	if (safeEnrichment && llmAutoApproveEnabled()) {
		if (review.status === 'applied') {
			// the coarse Phase-4 LLM_AUTOAPPROVE_CHANGE_REQUESTS already drove the apply.
			autoApplied = true;
		} else if (review.status === 'approved') {
			// advisory-recorded → apply now (flag + predicate allow it).
			try {
				await applyChangeRequest(db, crId, actor);
				autoApplied = true;
			} catch (e) {
				// a live re-plan that became conflicting bounces the CR to needs_evidence.
				if (!(e instanceof ChangeRequestStale)) throw e;
			}
		}
	}

	return { changeRequestId: crId, output, review, safeEnrichment, autoApplied };
}
