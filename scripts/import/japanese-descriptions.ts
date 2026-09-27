#!/usr/bin/env bun
/**
 * Apply reviewed Japanese descriptions to existing catalogue records.
 * Defaults to a read-only preview; --apply writes through the merge engine.
 */
import { eq, inArray } from 'drizzle-orm';
import { sources, sourceFieldClaims, sourceFieldProvenance } from '../../src/lib/server/db/schema';
import { mergeSourceObservation, planSourceObservation, canonicalStringify, type Db, type MergeInput } from '../../src/lib/server/merge';
import { parseImporterCli } from './lib/run';
import manifest from '../data/japanese-descriptions.json';
import { FIELD_POLICIES } from '../../src/lib/server/merge/field-policies';

export interface JapaneseDescription {
	slug: string;
	title: string;
	expectedSummary: string | null;
	summaryJa: string;
	basis?: string;
}

type Current = typeof sources.$inferSelect;

/** Reject stale identities, changed originals, and existing editorial translations. */
function check(entry: JapaneseDescription, row?: Current): boolean {
	if (!row || row.status !== 'active' || row.title !== entry.title) {
		throw new Error(`Source identity changed: ${entry.slug}`);
	}
	if (row.summary !== entry.expectedSummary) throw new Error(`Original description changed: ${entry.slug}`);
	if (row.summaryJa === entry.summaryJa) return false;
	if (row.summaryJa?.trim()) throw new Error(`Japanese description already exists: ${entry.slug}`);
	return true;
}

/** The projector replays all winning claims; stale winners must not undo catalogue edits. */
async function checkLedger(db: Db, rows: Current[]) {
	if (!rows.length) return;
	const winners = await db.select({ sourceId: sourceFieldProvenance.sourceId, field: sourceFieldClaims.fieldName, value: sourceFieldClaims.value })
		.from(sourceFieldProvenance)
		.innerJoin(sourceFieldClaims, eq(sourceFieldProvenance.currentClaimId, sourceFieldClaims.id))
		.where(inArray(sourceFieldProvenance.sourceId, rows.map((row) => row.id)));
	const byId = new Map(rows.map((row) => [row.id, row]));
	for (const winner of winners) {
		const row = byId.get(winner.sourceId)!;
		if (FIELD_POLICIES[winner.field]?.claimable &&
			canonicalStringify(row[winner.field as keyof Current]) !== canonicalStringify(winner.value)) {
			throw new Error(`Catalogue and edit history disagree: ${row.slug} (${winner.field})`);
		}
	}
}

const ENGINE_FIELDS = new Set(['summaryJa', 'updatedAt', 'contentHash', 'normalizerVersion', 'firstSeenAt', 'lastSeenAt', 'contentChangedAt', 'driftStatus']);

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
	const rows = await db.select().from(sources).where(inArray(sources.slug, [...slugs]));
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
	await checkLedger(db, pending.map((entry) => bySlug.get(entry.slug)!));
	let applied = 0;
	if (options.apply) {
		for (const entry of pending) {
			const [current] = await db.select().from(sources).where(eq(sources.slug, entry.slug));
			if (!check(entry, current)) continue;
			if (current.id !== bySlug.get(entry.slug)!.id) throw new Error(`Source identity changed: ${entry.slug}`);
			await checkLedger(db, [current]);
			const result = await mergeSourceObservation(db, observation(entry, current.id));
			if (result.status !== 'applied' && result.status !== 'noop') {
				throw new Error(`Description not applied (${result.status}): ${entry.slug}`);
			}
			const [after] = await db.select().from(sources).where(eq(sources.id, current.id));
			if (after.summary !== entry.expectedSummary || after.summaryJa !== entry.summaryJa) {
				throw new Error(`Description verification failed: ${entry.slug}`);
			}
			for (const field of Object.keys(current) as (keyof Current)[]) {
				if (!ENGINE_FIELDS.has(field) && canonicalStringify(after[field]) !== canonicalStringify(current[field])) {
					throw new Error(`Unexpected catalogue change: ${entry.slug} (${field})`);
				}
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
