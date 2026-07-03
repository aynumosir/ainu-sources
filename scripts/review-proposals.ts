#!/usr/bin/env bun
/**
 * LLM reviewer runner (Git-in-the-DB Phase 6).
 *
 * Fetches OPEN / NEEDS_EVIDENCE change requests and runs the advisory LLM reviewer
 * over each, printing a summary (verdict tally + auto-applied count + real token
 * usage / cost). Provider is selectable (Anthropic or OpenRouter) via env; usage
 * is captured off each provider response so a batch run totals the ACTUAL spend.
 *
 * Three record modes:
 *   • default (live)   — {@link reviewProposalWithLLM}: records the advisory review
 *                        AND advances the CR workflow (open→approved / needs_evidence
 *                        / rejected). Safe-enrichment auto-apply only fires when
 *                        `SOURCES_LLM_AUTOAPPROVE` is on AND the predicate holds.
 *   • --record-only    — STRICTLY APPEND-ONLY: append ONE `change_request_reviews`
 *                        row per CR (verdict + confidence + reason) and touch NOTHING
 *                        else — no CR status transition, no observation change, no
 *                        canonical/source write. This is the "previewed by LLMs"
 *                        advisory pass: only `change_request_reviews` grows.
 *   • --dry-run        — evaluate the would-be verdicts and record NOTHING.
 *
 * Idempotent / resumable: a CR already carrying an `llm` review is SKIPPED unless
 * `--force`. Concurrent (`--concurrency N`) with retry/backoff on 429/5xx.
 *
 * Run:
 *   bun run review:proposals                              # live, review the queue
 *   bun run review:proposals -- --dry-run                 # print would-be verdicts
 *   bun run review:proposals -- --record-only --all       # advisory append-only, whole queue
 *   bun run review:proposals -- --concurrency 8 --limit 5 # cap + parallelism
 *
 * Env: DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote Turso). For the reviewer:
 * LLM_PROVIDER=openrouter|anthropic (default anthropic), plus the matching key
 * (OPENROUTER_API_KEY / ANTHROPIC_API_KEY) and optionally LLM_MODEL=<id>.
 * SOURCES_LLM_AUTOAPPROVE=true enables safe-enrichment auto-apply on the LIVE path
 * only (never on --record-only / --dry-run).
 *
 * The `review:proposals` package script preloads `scripts/sveltekit-env-shim.ts`
 * so the merge engine's `$env/dynamic/private` / `$lib/paraglide/runtime` imports
 * resolve under bun.
 */
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import {
	buildLlmReviewContext,
	callLlmReviewer,
	isSafeEnrichment,
	llmAutoApproveEnabled,
	reviewProposalWithLLM,
	LLM_REVIEWER_MODEL,
	type LlmProvider,
	type LlmReviewClient,
	type LlmReviewOutput,
	type LlmUsage
} from '../src/lib/server/merge/llm-review';

type Db = LibSQLDatabase<typeof schema>;

/** CR workflow states the reviewer acts on (open + sent-back-for-evidence). */
const REVIEWABLE_STATUSES = ['open', 'needs_evidence'] as const;
const DEFAULT_LIMIT = 50;

export interface RunReviewProposalsOptions {
	/** print would-be verdicts WITHOUT recording anything (no review row, no apply). */
	dryRun?: boolean;
	/**
	 * STRICTLY APPEND-ONLY advisory: append ONE `change_request_reviews` row per CR
	 * and touch nothing else — NO CR status transition, NO observation change, NO
	 * canonical/source write. Overrides the live {@link reviewProposalWithLLM} path.
	 */
	recordOnly?: boolean;
	/** cap the batch (default {@link DEFAULT_LIMIT}). Ignored when `all` is set. */
	limit?: number;
	/** review the ENTIRE reviewable queue (no cap). */
	all?: boolean;
	/** re-review CRs that already carry an `llm` review. */
	force?: boolean;
	/** how many reviews to run in flight (default 1 — sequential). */
	concurrency?: number;
	/** max attempts per CR on a retryable (429/5xx/network) error (default 5). */
	retries?: number;
	/** inject a fake reviewer (tests / no network). */
	client?: LlmReviewClient;
	/** pick the backend (default: env `LLM_PROVIDER`). */
	provider?: LlmProvider;
	/** API key (default: the provider's env key). */
	apiKey?: string;
	/** override the reviewer model (also recorded as the reviewerActor). */
	model?: string;
	/** progress logger (default: no-op; the CLI passes console.log). */
	log?: (msg: string) => void;
}

export interface ReviewProposalsResultItem {
	changeRequestId: string;
	status: 'reviewed' | 'recorded' | 'dry-run' | 'skipped' | 'error';
	kind?: string;
	verdict?: LlmReviewOutput['verdict'];
	confidence?: number;
	safeEnrichment?: boolean;
	/** non-dry: did it auto-apply? dry: would it auto-apply (flag + predicate)? */
	autoApplied?: boolean;
	wouldAutoApply?: boolean;
	error?: string;
}

/** A verdict tally, reused for the whole run and per CR kind. */
export interface VerdictTally {
	apply: number;
	reject: number;
	needs_evidence: number;
}

/** Real token usage totalled off the provider responses. */
export interface UsageTotals {
	calls: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** summed provider-reported USD cost (OpenRouter `usage.cost`); 0 when unreported. */
	costUsd: number;
	/** true when at least one call reported a real cost. */
	costReported: boolean;
}

export interface ReviewProposalsSummary {
	dryRun: boolean;
	recordOnly: boolean;
	considered: number;
	reviewed: number;
	skipped: number;
	errors: number;
	verdicts: VerdictTally;
	verdictsByKind: Record<string, VerdictTally>;
	autoApplied: number;
	usage: UsageTotals;
	results: ReviewProposalsResultItem[];
}

const emptyTally = (): VerdictTally => ({ apply: 0, reject: 0, needs_evidence: 0 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is an error worth retrying — a rate limit (429), a server error (5xx), or a
 *  transient network fault? Keys off the message the provider clients throw. */
function isRetryable(e: unknown): boolean {
	const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
	if (/\berror 429\b|too many requests|rate limit/.test(m)) return true;
	if (/\berror 5\d\d\b/.test(m)) return true;
	if (/fetch failed|network|terminated|econnreset|etimedout|timeout|socket|eof/.test(m)) return true;
	return false;
}

/** Run `fn` with exponential backoff + jitter on retryable errors. */
async function withRetry<T>(
	fn: () => Promise<T>,
	opts: { retries: number; log?: (m: string) => void; label: string }
): Promise<T> {
	let attempt = 0;
	for (;;) {
		try {
			return await fn();
		} catch (e) {
			attempt++;
			if (attempt >= opts.retries || !isRetryable(e)) throw e;
			const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
			const msg = e instanceof Error ? e.message : String(e);
			opts.log?.(`  ${opts.label} retry ${attempt}/${opts.retries} in ${backoff}ms: ${msg.slice(0, 120)}`);
			await sleep(backoff);
		}
	}
}

/** The plain JSON payload recorded on `change_request_reviews.payload`. */
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

/**
 * Core runner — takes an explicit {@link Db} (matching the merge-engine / review-queue
 * convention) so it is directly unit-testable against an in-memory libSQL with a
 * FAKE reviewer client (no network). The CLI entry below wires the real DB + the
 * env-selected provider client.
 */
export async function runReviewProposals(
	db: Db,
	opts: RunReviewProposalsOptions = {}
): Promise<ReviewProposalsSummary> {
	const dryRun = !!opts.dryRun;
	const recordOnly = !!opts.recordOnly;
	const force = !!opts.force;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const concurrency = Math.max(1, opts.concurrency ?? 1);
	const retries = Math.max(1, opts.retries ?? 5);
	const reviewerActor = opts.model ?? LLM_REVIEWER_MODEL;
	const log = opts.log ?? (() => {});

	const usage: UsageTotals = {
		calls: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		costReported: false
	};
	const onUsage = (u: LlmUsage) => {
		usage.calls++;
		usage.promptTokens += u.promptTokens;
		usage.completionTokens += u.completionTokens;
		usage.totalTokens += u.totalTokens;
		if (typeof u.costUsd === 'number') {
			usage.costUsd += u.costUsd;
			usage.costReported = true;
		}
	};

	const summary: ReviewProposalsSummary = {
		dryRun,
		recordOnly,
		considered: 0,
		reviewed: 0,
		skipped: 0,
		errors: 0,
		verdicts: emptyTally(),
		verdictsByKind: {},
		autoApplied: 0,
		usage,
		results: []
	};

	const tallyVerdict = (kind: string | undefined, verdict: LlmReviewOutput['verdict']) => {
		summary.verdicts[verdict]++;
		const k = kind ?? 'unknown';
		(summary.verdictsByKind[k] ??= emptyTally())[verdict]++;
	};

	// fetch the reviewable queue, oldest first (fair ordering), capped unless `all`.
	const base = db
		.select({ id: schema.changeRequests.id, kind: schema.changeRequests.kind })
		.from(schema.changeRequests)
		.where(inArray(schema.changeRequests.status, [...REVIEWABLE_STATUSES]))
		.orderBy(asc(schema.changeRequests.createdAt));
	const crs = opts.all ? await base : await base.limit(limit);
	summary.considered = crs.length;

	const callOpts = {
		client: opts.client,
		provider: opts.provider,
		apiKey: opts.apiKey,
		model: opts.model,
		onUsage
	};

	const processOne = async ({ id, kind }: { id: string; kind: string }): Promise<void> => {
		// idempotent-friendly: skip a CR that already carries an LLM review.
		if (!force) {
			const [prior] = await db
				.select({ id: schema.changeRequestReviews.id })
				.from(schema.changeRequestReviews)
				.where(
					and(
						eq(schema.changeRequestReviews.changeRequestId, id),
						eq(schema.changeRequestReviews.reviewerKind, 'llm')
					)
				)
				.limit(1);
			if (prior) {
				summary.skipped++;
				summary.results.push({ changeRequestId: id, status: 'skipped', kind });
				log(`- ${id}  skipped (already LLM-reviewed)`);
				return;
			}
		}

		try {
			if (dryRun) {
				// evaluate the reviewer but record NOTHING.
				const context = await buildLlmReviewContext(db, id);
				const output = await withRetry(() => callLlmReviewer(context, callOpts), {
					retries,
					log,
					label: id
				});
				const safe = isSafeEnrichment(context, output);
				const wouldAutoApply = safe && llmAutoApproveEnabled();
				summary.reviewed++;
				tallyVerdict(kind, output.verdict);
				summary.results.push({
					changeRequestId: id,
					status: 'dry-run',
					kind,
					verdict: output.verdict,
					confidence: output.confidence,
					safeEnrichment: safe,
					wouldAutoApply
				});
				log(
					`~ ${id}  would ${output.verdict} (conf ${output.confidence})` +
						(wouldAutoApply ? '  [would auto-apply]' : '')
				);
			} else if (recordOnly) {
				// STRICTLY APPEND-ONLY: build → call → append the advisory review row.
				// NO status transition, NO observation change, NO canonical write.
				const context = await buildLlmReviewContext(db, id);
				const output = await withRetry(() => callLlmReviewer(context, callOpts), {
					retries,
					log,
					label: id
				});
				await db.insert(schema.changeRequestReviews).values({
					id: crypto.randomUUID(),
					changeRequestId: id,
					reviewerKind: 'llm',
					reviewerActor,
					verdict: output.verdict,
					confidence: output.confidence,
					reason: output.reason,
					evidenceRefs: output.evidenceRefs ?? [],
					payload: outputToPayload(output),
					createdAt: new Date()
				});
				summary.reviewed++;
				tallyVerdict(kind, output.verdict);
				summary.results.push({
					changeRequestId: id,
					status: 'recorded',
					kind,
					verdict: output.verdict,
					confidence: output.confidence
				});
				log(`+ ${id}  ${output.verdict} (conf ${output.confidence})  [advisory recorded]`);
			} else {
				const res = await withRetry(
					() => reviewProposalWithLLM(db, id, { ...callOpts, actor: reviewerActor }),
					{ retries, log, label: id }
				);
				summary.reviewed++;
				tallyVerdict(kind, res.output.verdict);
				if (res.autoApplied) summary.autoApplied++;
				summary.results.push({
					changeRequestId: id,
					status: 'reviewed',
					kind,
					verdict: res.output.verdict,
					confidence: res.output.confidence,
					safeEnrichment: res.safeEnrichment,
					autoApplied: res.autoApplied
				});
				log(
					`* ${id}  ${res.output.verdict}` +
						(res.autoApplied ? '  [auto-applied]' : '') +
						`  → CR ${res.review.status}`
				);
			}
		} catch (e) {
			summary.errors++;
			const message = e instanceof Error ? e.message : String(e);
			summary.results.push({ changeRequestId: id, status: 'error', kind, error: message });
			log(`! ${id}  error: ${message}`);
		}
	};

	// bounded worker pool — pull from a shared cursor. Sequential when concurrency=1.
	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const i = cursor++;
			if (i >= crs.length) return;
			await processOne(crs[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, crs.length) }, () => worker()));

	return summary;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliArgs {
	dryRun: boolean;
	recordOnly: boolean;
	force: boolean;
	all: boolean;
	limit?: number;
	concurrency?: number;
	provider?: LlmProvider;
}

function parseArgs(argv: string[]): CliArgs {
	const dryRun = argv.includes('--dry-run');
	const recordOnly = argv.includes('--record-only');
	const force = argv.includes('--force');
	const all = argv.includes('--all');
	let limit: number | undefined;
	let concurrency: number | undefined;
	let provider: LlmProvider | undefined;
	const num = (raw: string | undefined, flag: string): number => {
		const n = Number(raw);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${flag}: ${raw}`);
		return n;
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--limit') limit = num(argv[i + 1], '--limit');
		else if (a.startsWith('--limit=')) limit = num(a.slice('--limit='.length), '--limit');
		else if (a === '--concurrency') concurrency = num(argv[i + 1], '--concurrency');
		else if (a.startsWith('--concurrency=')) concurrency = num(a.slice('--concurrency='.length), '--concurrency');
		else if (a === '--provider') provider = argv[i + 1] as LlmProvider;
		else if (a.startsWith('--provider=')) provider = a.slice('--provider='.length) as LlmProvider;
	}
	return { dryRun, recordOnly, force, all, limit, concurrency, provider };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:') || url.startsWith(':memory:');
	if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');

	const provider = (args.provider ?? process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase() as LlmProvider;
	const apiKey = provider === 'openrouter' ? process.env.OPENROUTER_API_KEY : process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error(
			provider === 'openrouter' ? 'OPENROUTER_API_KEY is not set' : 'ANTHROPIC_API_KEY is not set'
		);
	}
	const model = process.env.LLM_MODEL;

	const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
	const db = drizzle(client, { schema });

	const mode = args.dryRun ? 'DRY RUN' : args.recordOnly ? 'RECORD-ONLY (advisory, append-only)' : 'live';
	console.log(
		`Reviewing proposals [${mode}] via ${provider}${model ? ` (${model})` : ''}` +
			`${args.force ? ', force' : ''}${args.all ? ', all' : ''}` +
			`, auto-approve ${llmAutoApproveEnabled() ? 'ON' : 'off'}, concurrency ${args.concurrency ?? 1}…\n`
	);

	const summary = await runReviewProposals(db, {
		dryRun: args.dryRun,
		recordOnly: args.recordOnly,
		force: args.force,
		all: args.all,
		limit: args.limit,
		concurrency: args.concurrency,
		provider,
		apiKey,
		model,
		log: (m) => console.log(m)
	});

	const u = summary.usage;
	const costStr = u.costReported ? `$${u.costUsd.toFixed(4)}` : 'n/a (provider did not report cost)';
	console.log(
		`\n${args.dryRun ? 'Would review' : 'Reviewed'} ${summary.reviewed}/${summary.considered} ` +
			`(skipped ${summary.skipped}, errors ${summary.errors}).\n` +
			`Verdicts: apply ${summary.verdicts.apply}, ` +
			`needs_evidence ${summary.verdicts.needs_evidence}, reject ${summary.verdicts.reject}.`
	);
	for (const [kind, t] of Object.entries(summary.verdictsByKind)) {
		console.log(`  ${kind}: apply ${t.apply}, needs_evidence ${t.needs_evidence}, reject ${t.reject}`);
	}
	console.log(
		`${args.dryRun ? 'Would auto-apply' : 'Auto-applied'}: ${
			args.dryRun ? summary.results.filter((r) => r.wouldAutoApply).length : summary.autoApplied
		}.\n` +
			`Usage: ${u.calls} calls, ${u.promptTokens} prompt + ${u.completionTokens} completion ` +
			`= ${u.totalTokens} tokens. Cost: ${costStr}.`
	);

	process.exit(summary.errors > 0 ? 1 : 0);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
