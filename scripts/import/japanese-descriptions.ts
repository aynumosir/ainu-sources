#!/usr/bin/env bun
/**
 * Apply reviewed Japanese descriptions to existing catalogue records.
 * Defaults to a read-only preview; --apply writes through the merge engine.
 */
import { eq, inArray } from 'drizzle-orm';
import { sources } from '../../src/lib/server/db/schema';
import { mergeSourceObservation, planSourceObservation, type Db, type MergeInput } from '../../src/lib/server/merge';
import { parseImporterCli } from './lib/run';
import manifest from '../data/japanese-descriptions.json';

export interface JapaneseDescription {
	slug: string;
	title: string;
	expectedSummary: string | null;
	summaryJa: string;
	basis?: string;
}

const columns = {
	id: sources.id, slug: sources.slug, title: sources.title,
	summary: sources.summary, summaryJa: sources.summaryJa, status: sources.status
};
type Current = typeof sources.$inferSelect;

/** Reject stale identities, changed originals, and existing editorial translations. */
function check(entry: JapaneseDescription, row?: Pick<Current, keyof typeof columns>): boolean {
	if (!row || row.status !== 'active' || row.title !== entry.title) {
		throw new Error(`Source identity changed: ${entry.slug}`);
	}
	if (row.summary !== entry.expectedSummary) throw new Error(`Original description changed: ${entry.slug}`);
	if (row.summaryJa === entry.summaryJa) return false;
	if (row.summaryJa?.trim()) throw new Error(`Japanese description already exists: ${entry.slug}`);
	return true;
}

function observation(entry: JapaneseDescription, sourceId: string): MergeInput {
	return {
		origin: 'japanese-descriptions',
		originRecordId: entry.slug,
		targetSourceId: sourceId,
		derivation: 'curated_assertion',
		confidence: 0.8,
		fields: { summaryJa: entry.summaryJa },
		rawPayload: { ...entry }
	};
}

/** Preflight the whole batch, then fill missing translations without changing originals. */
export async function run(
	db: Db,
	options: { apply?: boolean; entries?: JapaneseDescription[]; log?: (message: string) => void } = {}
) {
	const entries = options.entries ?? manifest;
	const slugs = new Set<string>();
	for (const entry of entries) {
		if (!entry.slug || !entry.title || !entry.summaryJa.trim() || entry.summaryJa !== entry.summaryJa.trim()) {
			throw new Error(`Invalid Japanese description: ${entry.slug}`);
		}
		if (slugs.has(entry.slug)) throw new Error(`Duplicate source: ${entry.slug}`);
		slugs.add(entry.slug);
	}
	if (!entries.length) return { total: 0, pending: 0, unchanged: 0, applied: 0 };
	const rows = await db.select(columns).from(sources).where(inArray(sources.slug, [...slugs]));
	const bySlug = new Map(rows.map((row) => [row.slug, row]));
	const pending = entries.filter((entry) => check(entry, bySlug.get(entry.slug)));
	// Canonical null can still carry an editorial deletion claim. Check precedence
	// for the entire batch before applying any translations.
	for (const entry of pending) {
		const row = bySlug.get(entry.slug)!;
		const plan = await planSourceObservation(db, observation(entry, row.id), { simulate: true });
		const outcomes = plan.predictedFieldOutcomes;
		if (plan.duplicate || plan.gate.mode !== 'auto_apply' || plan.identity.sourceId !== row.id ||
			outcomes.length !== 1 || outcomes[0].field !== 'summaryJa' || outcomes[0].status !== 'will_apply' ||
			plan.conflicts.length || plan.predictedConflicts.length || plan.heldClaims.length || plan.rejectedClaims.length) {
			throw new Error(`Japanese description blocked by merge review or provenance: ${entry.slug}`);
		}
	}
	let applied = 0;
	if (options.apply) {
		for (const entry of pending) {
			const [current] = await db.select(columns).from(sources).where(eq(sources.slug, entry.slug));
			if (!check(entry, current)) continue;
			if (current.id !== bySlug.get(entry.slug)!.id) throw new Error(`Source identity changed: ${entry.slug}`);
			const result = await mergeSourceObservation(db, observation(entry, current.id));
			if (result.status !== 'applied' && result.status !== 'noop') {
				throw new Error(`Description not applied (${result.status}): ${entry.slug}`);
			}
			const [after] = await db.select(columns).from(sources).where(eq(sources.id, current.id));
			if (after.summary !== entry.expectedSummary || after.summaryJa !== entry.summaryJa) {
				throw new Error(`Description verification failed: ${entry.slug}`);
			}
			applied += 1;
			options.log?.(`Applied Japanese description: ${entry.slug}`);
		}
	}
	return { total: entries.length, pending: pending.length, unchanged: entries.length - pending.length, applied };
}

if (import.meta.main) {
	const { db, opts } = parseImporterCli();
	const apply = process.argv.includes('--apply') && !opts.dryRun && !opts.plan;
	console.log({ mode: apply ? 'apply' : 'preview', ...await run(db, { apply, log: console.log }) });
}
