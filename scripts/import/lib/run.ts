/**
 * Run / emit / drift scaffolding shared by the harvest importers.
 *
 * Wraps the merge engine into the harvest-caller shape:
 *   • openRun / closeRun  — one `source_observation_runs` row per import invocation.
 *   • emitSource          — mergeSourceObservation + a guarded provenancePath-on-create
 *                           patch (the engine sets provenanceRepo from the origin but
 *                           never provenancePath — a projected column — and slugs a new
 *                           source from its title, not its repo path).
 *   • driftMissing        — the upstream-disappearance pass: any observed_record for
 *                           THIS origin not seen in the current run is re-observed with
 *                           presence:'missing', which the engine records as driftStatus
 *                           only. It NEVER deletes or mutates canonical data.
 *
 * Every write here is idempotent: emitSource routes through the engine (dup-noop on a
 * re-submit, value-hash noop per field), the provenancePath patch writes only when the
 * stored value actually differs (so an ATTACH to an existing, already-pathed source is
 * a no-op), and driftMissing re-observes rather than deletes.
 */
import { and, eq, ne } from 'drizzle-orm';
import { sources, sourceObservationRuns, sourceObservedRecords } from '../../../src/lib/server/db/schema';
import { mergeSourceObservation, NORMALIZER_VERSION } from '../../../src/lib/server/merge';
import type { Db, MergeInput, MergeResult } from '../../../src/lib/server/merge';
import { openDb } from './entities';

const uuid = () => crypto.randomUUID();

// ── orchestrator contract (import-all.ts) ──────────────────────────────────────
//
// Every importer exposes `run(db, opts) → ImporterSummary`, guarded by an
// `import.meta.main` CLI block so it stays runnable standalone (`bun run
// import:<feed>`) AND callable by the import-all orchestrator on ONE shared db
// handle. `run` opens its OWN source_observation_runs row (openRun/closeRun) and
// returns a normalized summary the orchestrator aggregates.

/** Flags the orchestrator (or a standalone CLI) passes down to an importer's run(). */
export interface ImporterRunOptions {
	/** derive + report but write nothing (pass-through --dry-run). */
	dryRun?: boolean;
	/** cap the number of upstream records processed (pass-through --limit). */
	limit?: number;
}

/**
 * The per-importer result the orchestrator aggregates. The five load-bearing
 * counters (applied · noop · candidate · conflict · drifted) are normalized across
 * every feed; `other` catches any residual engine status (e.g. a `proposed`
 * routed to review when SOURCES_ENABLE_PROPOSE is on) and `detail` carries the
 * importer-specific extras (entry counts, byType edges, filled columns, …).
 */
export interface ImporterSummary {
	feed: string;
	applied: number;
	noop: number;
	candidate: number;
	conflict: number;
	drifted: number;
	other: number;
	detail?: Record<string, unknown>;
}

/** The mutable per-record status counters an emit-loop importer keeps. */
export type StatusTally = {
	applied: number;
	noop: number;
	candidate: number;
	conflict: number;
	other: number;
};

/** Classify one MergeResult.status into a tally bucket (shared, so every feed agrees). */
export function tallyStatus(t: StatusTally, status: string): void {
	if (status === 'noop') t.noop += 1;
	else if (status === 'applied' || status === 'partial') t.applied += 1;
	else if (status === 'candidate') t.candidate += 1;
	else if (status === 'conflict') t.conflict += 1;
	else t.other += 1; // 'proposed' (propose path) and anything unforeseen
}

/** Fold a loose stats object + drift count into the normalized orchestrator summary. */
export function summarize(
	feed: string,
	stats: Partial<Record<'applied' | 'noop' | 'candidate' | 'conflict' | 'other', number>>,
	drifted: number,
	detail?: Record<string, unknown>
): ImporterSummary {
	return {
		feed,
		applied: stats.applied ?? 0,
		noop: stats.noop ?? 0,
		candidate: stats.candidate ?? 0,
		conflict: stats.conflict ?? 0,
		other: stats.other ?? 0,
		drifted,
		detail
	};
}

/**
 * Standalone-CLI bootstrap shared by every importer's `import.meta.main` guard.
 * Parses --db/DATABASE_URL (+ --token) into a live db handle and --dry-run/--limit
 * into ImporterRunOptions, exiting (never throwing) on a misconfigured invocation
 * so a directly-run importer fails fast with a clear message.
 */
export function parseImporterCli(): { db: Db; opts: ImporterRunOptions } {
	const argValue = (flag: string): string | undefined => {
		const i = process.argv.indexOf(flag);
		if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
		const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
		return eqForm ? eqForm.slice(flag.length + 1) : undefined;
	};
	const url = argValue('--db') ?? process.env.DATABASE_URL;
	if (!url) {
		console.error('✗ No database specified. Pass --db file:/path/to/db or set DATABASE_URL.');
		process.exit(1);
	}
	const isFile = url.startsWith('file:');
	const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
	if (!isFile && !authToken) {
		console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
		process.exit(1);
	}
	const dryRun = process.argv.includes('--dry-run');
	const limit = argValue('--limit') ? Number(argValue('--limit')) : Infinity;
	return { db: openDb(url, authToken), opts: { dryRun, limit } };
}

export interface OpenRunOpts {
	origin: string;
	/** full | incremental | targeted | manual | website */
	mode?: string;
	collectorVersion?: string;
	normalizerVersion?: number;
}

/** Open a `source_observation_runs` row (status='running'); returns its id. */
export async function openRun(db: Db, opts: OpenRunOpts): Promise<string> {
	const id = uuid();
	await db.insert(sourceObservationRuns).values({
		id,
		origin: opts.origin,
		mode: opts.mode ?? 'full',
		status: 'running',
		collectorVersion: opts.collectorVersion ?? null,
		normalizerVersion: opts.normalizerVersion ?? NORMALIZER_VERSION,
		startedAt: new Date()
	});
	return id;
}

/** Finalize a run row with its terminal status + summary. */
export async function closeRun(
	db: Db,
	runId: string,
	opts: { status?: string; summary?: Record<string, unknown> } = {}
): Promise<void> {
	await db
		.update(sourceObservationRuns)
		.set({
			status: opts.status ?? 'completed',
			finishedAt: new Date(),
			summary: opts.summary ?? null
		})
		.where(eq(sourceObservationRuns.id, runId));
}

export interface EmitOpts {
	/** provenanceRepo to stamp on a NEWLY created source (engine already sets it). */
	provenanceRepo?: string;
	/** provenancePath to stamp on a NEWLY created source (engine never sets it). */
	provenancePath?: string;
}

/**
 * Run one observation through the merge engine, then — only when the resulting
 * source's stored provenancePath/Repo actually differs from the intended value —
 * patch it by id. On an ATTACH to an already-bootstrapped source the stored path
 * equals the intended one, so ZERO write happens and the golden projection is
 * preserved; on a genuine CREATE the engine left provenancePath NULL, so this fills
 * it (and it is idempotent on the second run — the value now matches).
 */
export async function emitSource(db: Db, input: MergeInput, opts: EmitOpts = {}): Promise<MergeResult> {
	const result = await mergeSourceObservation(db, input);
	const sid = result.sourceId;
	if (!sid || (!opts.provenancePath && !opts.provenanceRepo)) return result;

	const [cur] = await db
		.select({ path: sources.provenancePath, repo: sources.provenanceRepo })
		.from(sources)
		.where(eq(sources.id, sid))
		.limit(1);
	const patch: Record<string, unknown> = {};
	if (opts.provenancePath && cur?.path !== opts.provenancePath) patch.provenancePath = opts.provenancePath;
	if (opts.provenanceRepo && cur?.repo !== opts.provenanceRepo) patch.provenanceRepo = opts.provenanceRepo;
	if (Object.keys(patch).length) await db.update(sources).set(patch).where(eq(sources.id, sid));
	return result;
}

/**
 * Mark every observed_record of `origin` NOT seen in this run as drifted-missing.
 * Re-observes each with presence:'missing' so the engine sets driftStatus='missing'
 * on the attached source (never a delete). Returns the count re-observed.
 */
export async function driftMissing(
	db: Db,
	origin: string,
	seen: Set<string>,
	opts: { derivation?: string; confidence?: number; runId?: string | null } = {}
): Promise<number> {
	const records = await db
		.select({ originRecordId: sourceObservedRecords.originRecordId })
		.from(sourceObservedRecords)
		.where(and(eq(sourceObservedRecords.origin, origin), ne(sourceObservedRecords.status, 'missing')));

	let missing = 0;
	for (const rec of records) {
		if (seen.has(rec.originRecordId)) continue;
		await mergeSourceObservation(db, {
			origin,
			originRecordId: rec.originRecordId,
			derivation: opts.derivation ?? 'curated_assertion',
			confidence: opts.confidence ?? 0.8,
			presence: 'missing',
			identifiers: [{ kind: 'repo_path', value: `${origin}:${rec.originRecordId}` }],
			runId: opts.runId ?? null
		});
		missing += 1;
	}
	return missing;
}
