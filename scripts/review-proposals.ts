#!/usr/bin/env bun
/**
 * LLM reviewer runner (Git-in-the-DB Phase 6).
 *
 * Fetches OPEN / NEEDS_EVIDENCE change requests and runs the advisory LLM reviewer
 * ({@link reviewProposalWithLLM}) over each, printing a summary (verdict tally +
 * auto-applied count). Safe-enrichment auto-approve only fires when the
 * `SOURCES_LLM_AUTOAPPROVE` env flag is on AND the conservative predicate holds;
 * everything else is recorded as an advisory review for a human to approve.
 *
 * Idempotent-friendly: a CR already carrying an `llm` review is SKIPPED unless
 * `--force`. `--dry-run` prints the would-be verdicts WITHOUT recording anything.
 *
 * Run:
 *   bun run review:proposals                 # review the queue, record verdicts
 *   bun run review:proposals -- --dry-run    # print would-be verdicts, record nothing
 *   bun run review:proposals -- --limit 20   # cap the batch
 *   bun run review:proposals -- --force      # re-review CRs already LLM-reviewed
 *
 * Env: DATABASE_URL (+ DATABASE_AUTH_TOKEN for remote Turso), ANTHROPIC_API_KEY,
 * and optionally SOURCES_LLM_AUTOAPPROVE=true to enable safe-enrichment auto-apply.
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
	type LlmReviewClient,
	type LlmReviewOutput
} from '../src/lib/server/merge/llm-review';

type Db = LibSQLDatabase<typeof schema>;

/** CR workflow states the reviewer acts on (open + sent-back-for-evidence). */
const REVIEWABLE_STATUSES = ['open', 'needs_evidence'] as const;
const DEFAULT_LIMIT = 50;

export interface RunReviewProposalsOptions {
	/** print would-be verdicts WITHOUT recording anything (no reviewChangeRequest / apply). */
	dryRun?: boolean;
	/** cap the batch (default {@link DEFAULT_LIMIT}). */
	limit?: number;
	/** re-review CRs that already carry an `llm` review. */
	force?: boolean;
	/** inject a fake reviewer (tests / no network). */
	client?: LlmReviewClient;
	/** Anthropic API key (default: env). */
	apiKey?: string;
	/** override the reviewer model. */
	model?: string;
	/** progress logger (default: no-op; the CLI passes console.log). */
	log?: (msg: string) => void;
}

export interface ReviewProposalsResultItem {
	changeRequestId: string;
	status: 'reviewed' | 'dry-run' | 'skipped' | 'error';
	verdict?: LlmReviewOutput['verdict'];
	confidence?: number;
	safeEnrichment?: boolean;
	/** non-dry: did it auto-apply? dry: would it auto-apply (flag + predicate)? */
	autoApplied?: boolean;
	wouldAutoApply?: boolean;
	error?: string;
}

export interface ReviewProposalsSummary {
	dryRun: boolean;
	considered: number;
	reviewed: number;
	skipped: number;
	errors: number;
	verdicts: { apply: number; reject: number; needs_evidence: number };
	autoApplied: number;
	results: ReviewProposalsResultItem[];
}

/**
 * Core runner — takes an explicit {@link Db} (matching the merge-engine / review-queue
 * convention) so it is directly unit-testable against an in-memory libSQL with a
 * FAKE reviewer client (no network). The CLI entry below wires the real DB + the
 * default Anthropic client.
 */
export async function runReviewProposals(
	db: Db,
	opts: RunReviewProposalsOptions = {}
): Promise<ReviewProposalsSummary> {
	const dryRun = !!opts.dryRun;
	const force = !!opts.force;
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const log = opts.log ?? (() => {});

	const summary: ReviewProposalsSummary = {
		dryRun,
		considered: 0,
		reviewed: 0,
		skipped: 0,
		errors: 0,
		verdicts: { apply: 0, reject: 0, needs_evidence: 0 },
		autoApplied: 0,
		results: []
	};

	// fetch the reviewable queue, oldest first (fair ordering), capped.
	const crs = await db
		.select({ id: schema.changeRequests.id })
		.from(schema.changeRequests)
		.where(inArray(schema.changeRequests.status, [...REVIEWABLE_STATUSES]))
		.orderBy(asc(schema.changeRequests.createdAt))
		.limit(limit);
	summary.considered = crs.length;

	for (const { id } of crs) {
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
				summary.results.push({ changeRequestId: id, status: 'skipped' });
				log(`- ${id}  skipped (already LLM-reviewed)`);
				continue;
			}
		}

		try {
			if (dryRun) {
				// evaluate the reviewer but record NOTHING.
				const context = await buildLlmReviewContext(db, id);
				const output = await callLlmReviewer(context, {
					client: opts.client,
					apiKey: opts.apiKey,
					model: opts.model
				});
				const safe = isSafeEnrichment(context, output);
				const wouldAutoApply = safe && llmAutoApproveEnabled();
				summary.reviewed++;
				summary.verdicts[output.verdict]++;
				summary.results.push({
					changeRequestId: id,
					status: 'dry-run',
					verdict: output.verdict,
					confidence: output.confidence,
					safeEnrichment: safe,
					wouldAutoApply
				});
				log(
					`~ ${id}  would ${output.verdict} (conf ${output.confidence})` +
						(wouldAutoApply ? '  [would auto-apply]' : '')
				);
			} else {
				const res = await reviewProposalWithLLM(db, id, {
					client: opts.client,
					apiKey: opts.apiKey,
					model: opts.model
				});
				summary.reviewed++;
				summary.verdicts[res.output.verdict]++;
				if (res.autoApplied) summary.autoApplied++;
				summary.results.push({
					changeRequestId: id,
					status: 'reviewed',
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
			summary.results.push({ changeRequestId: id, status: 'error', error: message });
			log(`! ${id}  error: ${message}`);
		}
	}

	return summary;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dryRun: boolean; force: boolean; limit?: number } {
	const dryRun = argv.includes('--dry-run');
	const force = argv.includes('--force');
	let limit: number | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--limit') limit = Number(argv[i + 1]);
		else if (a.startsWith('--limit=')) limit = Number(a.slice('--limit='.length));
	}
	if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
		throw new Error(`invalid --limit: ${limit}`);
	}
	return { dryRun, force, limit };
}

async function main(): Promise<void> {
	const { dryRun, force, limit } = parseArgs(process.argv.slice(2));

	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:') || url.startsWith(':memory:');
	if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');
	if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');

	const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
	const db = drizzle(client, { schema });

	console.log(
		`Reviewing proposals (${dryRun ? 'DRY RUN' : 'live'}${force ? ', force' : ''}` +
			`, auto-approve ${llmAutoApproveEnabled() ? 'ON' : 'off'})…\n`
	);

	const summary = await runReviewProposals(db, {
		dryRun,
		force,
		limit,
		apiKey: process.env.ANTHROPIC_API_KEY,
		log: (m) => console.log(m)
	});

	console.log(
		`\n${dryRun ? 'Would review' : 'Reviewed'} ${summary.reviewed}/${summary.considered} ` +
			`(skipped ${summary.skipped}, errors ${summary.errors}).\n` +
			`Verdicts: apply ${summary.verdicts.apply}, ` +
			`needs_evidence ${summary.verdicts.needs_evidence}, reject ${summary.verdicts.reject}.\n` +
			`${dryRun ? 'Would auto-apply' : 'Auto-applied'}: ${
				dryRun
					? summary.results.filter((r) => r.wouldAutoApply).length
					: summary.autoApplied
			}.`
	);

	process.exit(summary.errors > 0 ? 1 : 0);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
