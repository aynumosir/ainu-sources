#!/usr/bin/env bun
/**
 * apply-approved — drain the LLM-vetted review queue OFFLINE (Git-in-the-DB Phase 5).
 *
 * The LLM reviewer (`review:proposals`, Phase 6) marks a proposal `approved` — an
 * ADVISORY verdict: it does NOT make the source live. Something still has to APPLY
 * each approved change request through the merge engine to write canonical data
 * (materialize the new source / land the enrichment) and flip the CR
 * `approved` → `applied`. The web /admin/review UI does exactly that, ONE CR at a
 * time — but draining ~952 approved CRs there would blow the Cloudflare Worker
 * subrequest budget (each apply re-plans live + commits = many round-trips). So this
 * is the offline batch counterpart to `import:all`: it runs the SAME engine entry
 * point (`applyChangeRequest`) over the queue from a workstation with no Worker limit.
 *
 * HUMAN OVERSIGHT (tiers): an LLM `approved` verdict is advisory, so the human keeps
 * the final say over WHICH tiers go public. The filters below let the operator apply
 * a slice at a time — a kind (`new_source` / `enrichment` / `identity_conflict`), a
 * minimum LLM confidence, a count cap — and `--dry-run` previews the exact slice
 * (counts by kind + confidence bucket + total) WITHOUT touching canonical data.
 *
 * NO BYPASS: every apply goes through `applyChangeRequest`, which re-plans LIVE
 * against current canonical (rebase-before-merge), commits through the ONE merge
 * engine (no rank change, no precedence shortcut), writes the `applied` diff, and
 * flips the CR. This script only SELECTS and DRIVES — it writes no canonical data
 * itself and deletes nothing.
 *
 * IDEMPOTENT + RESUMABLE: the selection query is `status='approved'`, so an
 * already-applied CR is never re-selected; a re-run (or a run resumed after an
 * interruption) picks up only the remaining approved CRs and a fully-drained queue
 * is a pure noop (0 applied). A CR that becomes conflicting / now-rejected on the
 * live re-plan throws {@link ChangeRequestStale} — it is LEFT AS-IS (bounced back to
 * `needs_evidence` by the engine) and logged, never hard-failed.
 *
 * Filters (default = ALL approved):
 *   --kind <k[,k…]>            new_source | enrichment | identity_conflict |
 *                              field_update | lifecycle | drift  (repeatable / csv)
 *   --min-llm-confidence <0..1> keep only CRs whose latest LLM review confidence ≥ n
 *                              (a CR with no LLM review is EXCLUDED once this is set)
 *   --limit N                  cap the slice (oldest-first)
 *   --dry-run                  preview the slice (no writes; does NOT call the engine)
 *   --concurrency N            parallel applies (default 6)
 *   --retries N                max attempts per CR on a transient error (default 5)
 *   --actor <id>               audit-only decidedByActor (default 'apply-approved')
 *
 * Run:
 *   DATABASE_URL=file:/tmp/clone.db bun run apply:approved -- --dry-run
 *   DATABASE_URL=file:/tmp/clone.db bun run apply:approved -- --kind new_source --limit 20
 *   DATABASE_URL=file:/tmp/clone.db bun run apply:approved -- --min-llm-confidence 0.9
 *
 * Env: DATABASE_URL (+ DATABASE_AUTH_TOKEN for a remote Turso url). The
 * `apply:approved` package script preloads `scripts/sveltekit-env-shim.ts` so the
 * merge engine's `$env/dynamic/private` / `$lib/paraglide/runtime` imports resolve
 * under bun (same as `review:proposals` / `import:all`).
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import {
	applyChangeRequest,
	ChangeRequestStale
} from '../src/lib/server/merge/merge-source-observation';
import type { Db } from '../src/lib/server/merge/types';
import { openDb } from './import/lib/entities';

/** The CR kinds a proposal can carry (schema.change_requests.kind). */
const KNOWN_KINDS = [
	'new_source',
	'enrichment',
	'identity_conflict',
	'field_update',
	'lifecycle',
	'drift'
] as const;

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRIES = 5;
const DEFAULT_ACTOR = 'apply-approved';

// ---------------------------------------------------------------------------
// Options + result shapes (exported so the runner is unit-testable, matching the
// review-proposals.ts convention).
// ---------------------------------------------------------------------------

export interface RunApplyApprovedOptions {
	/** restrict to these CR kinds (default: all approved). */
	kinds?: string[];
	/** keep only CRs whose latest LLM review confidence ≥ this (0..1). */
	minLlmConfidence?: number;
	/** cap the slice (oldest-first). */
	limit?: number;
	/** preview the slice — count by kind + confidence bucket + total; NO writes. */
	dryRun?: boolean;
	/** parallel applies (default {@link DEFAULT_CONCURRENCY}). */
	concurrency?: number;
	/** max attempts per CR on a transient error (default {@link DEFAULT_RETRIES}). */
	retries?: number;
	/** audit-only decidedByActor recorded by the engine (never precedence). */
	actor?: string;
	/** progress logger (default: no-op; the CLI passes console.log). */
	log?: (msg: string) => void;
}

export type ApplyItemStatus =
	| 'applied'
	| 'skipped-already'
	| 'stale-bounced'
	| 'error'
	| 'would-apply';

export interface ApplyApprovedResultItem {
	changeRequestId: string;
	kind: string;
	status: ApplyItemStatus;
	/** the CR's latest LLM review confidence (null when it has no LLM review). */
	llmConfidence: number | null;
	/** the engine MergeResult.status (applied path only). */
	mergeStatus?: string;
	sourceId?: string;
	error?: string;
}

export interface ApplyApprovedSummary {
	dryRun: boolean;
	/** how many approved CRs matched the filters (the slice size). */
	selected: number;
	applied: number;
	skippedAlready: number;
	staleBounced: number;
	errors: number;
	/** applied CRs of kind `new_source` — the new ACTIVE sources this run created. */
	newSources: number;
	/** applied CRs of kind `enrichment` — the enrichments this run landed. */
	enrichments: number;
	/** selected-slice counts by CR kind. */
	byKind: Record<string, number>;
	/** selected-slice counts by LLM-confidence bucket. */
	byConfidenceBucket: Record<string, number>;
	results: ApplyApprovedResultItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Coarse LLM-confidence buckets for the dry-run preview / summary. */
export function confidenceBucket(c: number | null | undefined): string {
	if (c == null) return 'none';
	if (c >= 0.9) return '≥0.9';
	if (c >= 0.75) return '0.75–0.9';
	if (c >= 0.5) return '0.5–0.75';
	return '<0.5';
}

/** Split an inArray probe into chunks under SQLite's bound-variable ceiling. */
function chunk<T>(xs: T[], size = 400): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
	return out;
}

/** Is an error worth retrying — a transient network / server / lock fault? A
 *  {@link ChangeRequestStale} is NEVER retryable (it is a deliberate rebase bounce). */
function isRetryable(e: unknown): boolean {
	if (e instanceof ChangeRequestStale) return false;
	const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
	if (/\berror 5\d\d\b|too many requests|rate limit|429/.test(m)) return true;
	if (/fetch failed|network|terminated|econnreset|etimedout|timeout|socket|eof|database is locked|busy/.test(m))
		return true;
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

/**
 * Latest LLM-review confidence per CR id, in ONE batched read (chunked inArray).
 * A CR may carry several `llm` reviews (re-reviews); the LAST by createdAt wins —
 * the confidence the CR was `approved` on. CRs with no LLM review are absent from
 * the map (→ `null` confidence at the call site).
 */
async function loadLlmConfidence(db: Db, crIds: string[]): Promise<Map<string, number | null>> {
	const map = new Map<string, number | null>();
	if (!crIds.length) return map;
	for (const ids of chunk(crIds)) {
		const rows = await db
			.select({
				crId: schema.changeRequestReviews.changeRequestId,
				confidence: schema.changeRequestReviews.confidence,
				createdAt: schema.changeRequestReviews.createdAt
			})
			.from(schema.changeRequestReviews)
			.where(
				and(
					inArray(schema.changeRequestReviews.changeRequestId, ids),
					eq(schema.changeRequestReviews.reviewerKind, 'llm')
				)
			)
			.orderBy(asc(schema.changeRequestReviews.createdAt));
		// ordered oldest→newest, so the last write per CR is its latest review.
		for (const r of rows) map.set(r.crId, r.confidence ?? null);
	}
	return map;
}

// ---------------------------------------------------------------------------
// Core runner (exported; takes an explicit Db so it is directly unit-testable
// against an in-memory libSQL — the merge-engine / review-queue convention).
// ---------------------------------------------------------------------------

export async function runApplyApproved(
	db: Db,
	opts: RunApplyApprovedOptions = {}
): Promise<ApplyApprovedSummary> {
	const dryRun = !!opts.dryRun;
	const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
	const retries = Math.max(1, opts.retries ?? DEFAULT_RETRIES);
	const actor = opts.actor ?? DEFAULT_ACTOR;
	const log = opts.log ?? (() => {});
	const kinds = opts.kinds?.length ? [...new Set(opts.kinds)] : undefined;
	const minConf = opts.minLlmConfidence;

	// 1. fetch the approved queue (optionally kind-filtered), oldest-first (fair).
	const where = kinds
		? and(eq(schema.changeRequests.status, 'approved'), inArray(schema.changeRequests.kind, kinds))
		: eq(schema.changeRequests.status, 'approved');
	const approved = await db
		.select({ id: schema.changeRequests.id, kind: schema.changeRequests.kind })
		.from(schema.changeRequests)
		.where(where)
		.orderBy(asc(schema.changeRequests.createdAt));

	// 2. attach each CR's latest LLM-review confidence (one batched read).
	const confByCr = await loadLlmConfidence(
		db,
		approved.map((c) => c.id)
	);
	let slice = approved.map((c) => ({
		id: c.id,
		kind: c.kind,
		llmConfidence: confByCr.get(c.id) ?? null
	}));

	// 3. min-llm-confidence tier gate (a CR with no LLM review can't clear the bar).
	if (typeof minConf === 'number') {
		slice = slice.filter((c) => c.llmConfidence != null && c.llmConfidence >= minConf);
	}
	// 4. cap the slice (oldest-first) LAST, so the count reflects the whole tier.
	if (typeof opts.limit === 'number' && opts.limit >= 0) slice = slice.slice(0, opts.limit);

	const summary: ApplyApprovedSummary = {
		dryRun,
		selected: slice.length,
		applied: 0,
		skippedAlready: 0,
		staleBounced: 0,
		errors: 0,
		newSources: 0,
		enrichments: 0,
		byKind: {},
		byConfidenceBucket: {},
		results: []
	};
	for (const c of slice) {
		summary.byKind[c.kind] = (summary.byKind[c.kind] ?? 0) + 1;
		const b = confidenceBucket(c.llmConfidence);
		summary.byConfidenceBucket[b] = (summary.byConfidenceBucket[b] ?? 0) + 1;
	}

	// 5a. DRY-RUN: preview the slice only — count by kind + confidence bucket + total.
	//     NO engine call, NO write (this is how the human vets a tier before applying).
	if (dryRun) {
		for (const c of slice) {
			summary.results.push({
				changeRequestId: c.id,
				kind: c.kind,
				status: 'would-apply',
				llmConfidence: c.llmConfidence
			});
			log(`~ ${c.id}  would apply (${c.kind}, conf ${c.llmConfidence ?? 'n/a'})`);
		}
		return summary;
	}

	// 5b. LIVE: drive `applyChangeRequest` for each selected CR through the engine.
	const processOne = async (c: { id: string; kind: string; llmConfidence: number | null }): Promise<void> => {
		// resumable guard: a CR flipped to `applied` (a prior/interrupted run) is
		// skipped — never re-applied — even if it slipped into a stale selection.
		const [cur] = await db
			.select({ status: schema.changeRequests.status })
			.from(schema.changeRequests)
			.where(eq(schema.changeRequests.id, c.id))
			.limit(1);
		if (cur?.status === 'applied') {
			summary.skippedAlready++;
			summary.results.push({ changeRequestId: c.id, kind: c.kind, status: 'skipped-already', llmConfidence: c.llmConfidence });
			log(`- ${c.id}  skipped (already applied)`);
			return;
		}

		try {
			const result = await withRetry(() => applyChangeRequest(db, c.id, actor), {
				retries,
				log,
				label: c.id
			});
			summary.applied++;
			if (c.kind === 'new_source') summary.newSources++;
			else if (c.kind === 'enrichment') summary.enrichments++;
			summary.results.push({
				changeRequestId: c.id,
				kind: c.kind,
				status: 'applied',
				llmConfidence: c.llmConfidence,
				mergeStatus: result.status,
				sourceId: result.sourceId
			});
			log(`* ${c.id}  applied → ${result.status}${result.sourceId ? ` (source ${result.sourceId})` : ''}`);
		} catch (e) {
			if (e instanceof ChangeRequestStale) {
				// became conflicting / now-rejected on the live re-plan: the engine bounced
				// it to needs_evidence. LEAVE AS-IS and log — never a hard failure.
				summary.staleBounced++;
				summary.results.push({
					changeRequestId: c.id,
					kind: c.kind,
					status: 'stale-bounced',
					llmConfidence: c.llmConfidence,
					error: e.message
				});
				log(`⤺ ${c.id}  stale on re-plan (${e.crStatus ?? 'bounced'}): ${e.message}`);
				return;
			}
			summary.errors++;
			const message = e instanceof Error ? e.message : String(e);
			summary.results.push({ changeRequestId: c.id, kind: c.kind, status: 'error', llmConfidence: c.llmConfidence, error: message });
			log(`! ${c.id}  error: ${message}`);
		}
	};

	// bounded worker pool — pull from a shared cursor (sequential when concurrency=1).
	let cursor = 0;
	const worker = async () => {
		for (;;) {
			const i = cursor++;
			if (i >= slice.length) return;
			await processOne(slice[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, slice.length) }, () => worker()));

	return summary;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

interface CliArgs {
	kinds?: string[];
	minLlmConfidence?: number;
	limit?: number;
	dryRun: boolean;
	concurrency?: number;
	retries?: number;
	actor?: string;
}

function parseArgs(argv: string[]): CliArgs {
	const dryRun = argv.includes('--dry-run');
	const kinds: string[] = [];
	let minLlmConfidence: number | undefined;
	let limit: number | undefined;
	let concurrency: number | undefined;
	let retries: number | undefined;
	let actor: string | undefined;

	const num = (raw: string | undefined, flag: string): number => {
		const n = Number(raw);
		if (!Number.isFinite(n)) throw new Error(`invalid ${flag}: ${raw}`);
		return n;
	};
	const pushKinds = (raw: string | undefined) => {
		if (!raw) return;
		for (const k of raw.split(',').map((s) => s.trim()).filter(Boolean)) kinds.push(k);
	};

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--kind') pushKinds(argv[++i]);
		else if (a.startsWith('--kind=')) pushKinds(a.slice('--kind='.length));
		else if (a === '--min-llm-confidence') minLlmConfidence = num(argv[++i], '--min-llm-confidence');
		else if (a.startsWith('--min-llm-confidence=')) minLlmConfidence = num(a.slice('--min-llm-confidence='.length), '--min-llm-confidence');
		else if (a === '--limit') limit = num(argv[++i], '--limit');
		else if (a.startsWith('--limit=')) limit = num(a.slice('--limit='.length), '--limit');
		else if (a === '--concurrency') concurrency = num(argv[++i], '--concurrency');
		else if (a.startsWith('--concurrency=')) concurrency = num(a.slice('--concurrency='.length), '--concurrency');
		else if (a === '--retries') retries = num(argv[++i], '--retries');
		else if (a.startsWith('--retries=')) retries = num(a.slice('--retries='.length), '--retries');
		else if (a === '--actor') actor = argv[++i];
		else if (a.startsWith('--actor=')) actor = a.slice('--actor='.length);
	}

	// validate kinds early so a typo fails fast (before touching the DB).
	for (const k of kinds) {
		if (!(KNOWN_KINDS as readonly string[]).includes(k)) {
			throw new Error(`unknown --kind '${k}'. Known: ${KNOWN_KINDS.join(', ')}.`);
		}
	}
	if (minLlmConfidence != null && (minLlmConfidence < 0 || minLlmConfidence > 1)) {
		throw new Error(`--min-llm-confidence must be in [0,1], got ${minLlmConfidence}.`);
	}

	return {
		kinds: kinds.length ? kinds : undefined,
		minLlmConfidence,
		limit,
		dryRun,
		concurrency,
		retries,
		actor
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const url = process.env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:') || url.startsWith(':memory:');
	if (!isFile && !process.env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');

	const db = openDb(url, process.env.DATABASE_AUTH_TOKEN);

	const mode = args.dryRun ? 'DRY-RUN (preview, no writes)' : 'apply';
	console.log(
		`apply-approved [${mode}] → ${url.split('?')[0]}` +
			`  (kinds: ${args.kinds?.join(',') ?? 'all'}` +
			`${args.minLlmConfidence != null ? `, min-conf ${args.minLlmConfidence}` : ''}` +
			`${args.limit != null ? `, limit ${args.limit}` : ''}` +
			`, concurrency ${args.concurrency ?? DEFAULT_CONCURRENCY})\n`
	);

	const t0 = Date.now();
	const summary = await runApplyApproved(db, {
		kinds: args.kinds,
		minLlmConfidence: args.minLlmConfidence,
		limit: args.limit,
		dryRun: args.dryRun,
		concurrency: args.concurrency,
		retries: args.retries,
		actor: args.actor,
		log: (m) => console.log(m)
	});

	console.log(`\n=== apply-approved ${args.dryRun ? '(dry-run) ' : ''}summary ===`);
	console.log(`selected: ${summary.selected} approved CR(s) matched the filters`);
	if (Object.keys(summary.byKind).length) {
		console.log('by kind:');
		console.table(summary.byKind);
	}
	if (Object.keys(summary.byConfidenceBucket).length) {
		console.log('by LLM-confidence bucket:');
		console.table(summary.byConfidenceBucket);
	}

	if (args.dryRun) {
		console.log(
			`\nWOULD apply ${summary.selected} CR(s) — ` +
				`${summary.byKind['new_source'] ?? 0} new source(s), ` +
				`${summary.byKind['enrichment'] ?? 0} enrichment(s). No writes performed.`
		);
		console.log(`\n✓ dry-run complete — nothing written (${((Date.now() - t0) / 1000).toFixed(1)}s).`);
		process.exit(0);
	}

	console.log(
		`\napplied=${summary.applied} skipped-already=${summary.skippedAlready} ` +
			`stale-bounced=${summary.staleBounced} errors=${summary.errors}\n` +
			`resulted in ${summary.newSources} new active source(s) + ${summary.enrichments} enrichment(s) ` +
			`(${((Date.now() - t0) / 1000).toFixed(1)}s).`
	);

	if (summary.errors > 0) {
		console.error(`\n✗ ${summary.errors} CR(s) errored (see log above).`);
		process.exit(1);
	}
	console.log(`\n✓ apply-approved complete — every apply went through the merge engine; nothing deleted.`);
	process.exit(0);
}

if (import.meta.main) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
