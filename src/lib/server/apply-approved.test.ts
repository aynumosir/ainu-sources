/**
 * scripts/apply-approved.ts — runner (Git-in-the-DB Phase 5).
 *
 * Exercises the exported {@link runApplyApproved} core against a real :memory: DB
 * (NO network). Proves:
 *   1. a seeded APPROVED new_source CR applies → CR `approved`→`applied`, canonical
 *      source materialized, observation flipped, and a re-run is a pure NOOP
 *      (idempotent / resumable — the drained CR is no longer selected);
 *   2. --dry-run previews the slice (counts by kind + confidence bucket) and writes
 *      NOTHING (CR stays `approved`, no canonical source);
 *   3. the FILTERS slice correctly: `--kind` leaves other-kind approved CRs
 *      untouched; `--min-llm-confidence` excludes CRs below the bar (and CRs with no
 *      LLM review), driving only the vetted tier.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from './db/schema';
import { mergeSourceObservation } from './merge/merge-source-observation';
import type { MergeInput, ProposedMergeResult } from './merge/types';
import { runApplyApproved, confidenceBucket } from '../../../scripts/apply-approved';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

async function makeDb(): Promise<Db> {
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

let db: Db;
beforeEach(async () => {
	db = await makeDb();
});
afterEach(() => {
	delete env.SOURCES_ENABLE_PROPOSE;
});

const enablePropose = () => {
	env.SOURCES_ENABLE_PROPOSE = 'true';
};

const observed = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'crossref',
	originRecordId: 'crossref:base',
	derivation: 'observed',
	confidence: 0.9,
	fields: { title: 'A Work', type: 'article', category: 'secondary' },
	...over
});

const llmEnrichment = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'openalex',
	originRecordId: 'openalex:enrich-1',
	derivation: 'llm_extraction',
	confidence: 0.9,
	evidence: 2,
	identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
	fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'an LLM summary' },
	...over
});

/** Auto-apply an existing source (flag OFF) so an enrichment has something to attach to. */
async function seedSource(): Promise<string> {
	const r = await mergeSourceObservation(
		db,
		observed({ originRecordId: 'crossref:seed', identifiers: [{ kind: 'doi', value: '10.1234/seed' }] })
	);
	return r.sourceId!;
}

async function propose(input: MergeInput): Promise<ProposedMergeResult> {
	enablePropose();
	const r = (await mergeSourceObservation(db, input)) as ProposedMergeResult;
	expect(r.status).toBe('proposed');
	return r;
}

/** Move a CR to `approved` (the LLM-vetted state), optionally recording an LLM review
 *  row so `--min-llm-confidence` has something to key off. */
async function approve(crId: string, llmConfidence?: number): Promise<void> {
	await db.update(schema.changeRequests).set({ status: 'approved' }).where(eq(schema.changeRequests.id, crId));
	if (llmConfidence != null) {
		await db.insert(schema.changeRequestReviews).values({
			id: crypto.randomUUID(),
			changeRequestId: crId,
			reviewerKind: 'llm',
			reviewerActor: 'test-model',
			verdict: 'apply',
			confidence: llmConfidence,
			reason: 'looks good',
			evidenceRefs: [],
			payload: {},
			createdAt: new Date()
		});
	}
}

const crRow = async (id: string) =>
	(await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)))[0];
const sourceCount = async () => (await db.select().from(schema.sources)).length;

describe('runApplyApproved — applies an approved CR, idempotent re-run is a noop', () => {
	it('a seeded approved new_source CR → applied, canonical written, 2nd run 0 applied', async () => {
		const cr = await propose(
			observed({
				originRecordId: 'crossref:new-approved',
				fields: { title: 'Newly Approved Work', type: 'article', category: 'secondary' }
			})
		);
		expect((await crRow(cr.changeRequestId)).kind).toBe('new_source');
		await approve(cr.changeRequestId, 0.95);

		// no canonical yet — a proposal / approval mutates ZERO canonical data.
		expect(await sourceCount()).toBe(0);

		const first = await runApplyApproved(db, {});
		expect(first.selected).toBe(1);
		expect(first.applied).toBe(1);
		expect(first.newSources).toBe(1);
		expect(first.skippedAlready).toBe(0);
		expect(first.staleBounced).toBe(0);
		expect(first.errors).toBe(0);

		// CR finalized + canonical source materialized through the engine.
		const applied = await crRow(cr.changeRequestId);
		expect(applied.status).toBe('applied');
		expect(applied.decidedByActor).toBe('apply-approved');
		expect(await sourceCount()).toBe(1);
		const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, applied.sourceId!));
		expect(src.title).toBe('Newly Approved Work');

		// idempotent / resumable: a 2nd run selects nothing (CR no longer `approved`) → noop.
		const second = await runApplyApproved(db, {});
		expect(second.selected).toBe(0);
		expect(second.applied).toBe(0);
		expect(await sourceCount()).toBe(1); // no duplicate source
	});
});

describe('runApplyApproved — --dry-run previews the slice and writes nothing', () => {
	it('reports counts by kind + confidence bucket, applies nothing', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:dry', fields: { title: 'Dry Work', type: 'article', category: 'secondary' } }));
		await approve(cr.changeRequestId, 0.95);

		const summary = await runApplyApproved(db, { dryRun: true });
		expect(summary.dryRun).toBe(true);
		expect(summary.selected).toBe(1);
		expect(summary.applied).toBe(0);
		expect(summary.byKind).toEqual({ new_source: 1 });
		expect(summary.byConfidenceBucket).toEqual({ '≥0.9': 1 });
		expect(summary.results[0].status).toBe('would-apply');

		// NOTHING written: CR still approved, no canonical source.
		expect((await crRow(cr.changeRequestId)).status).toBe('approved');
		expect(await sourceCount()).toBe(0);
	});
});

describe('runApplyApproved — filters slice the tier (human oversight)', () => {
	it('--kind applies only the matching kind; other-kind approved CRs are untouched', async () => {
		await seedSource();
		// an enrichment CR (low-trust attach adding summary) + a fresh new_source CR
		const enrich = await propose(llmEnrichment({ originRecordId: 'openalex:enrich-kind' }));
		expect((await crRow(enrich.changeRequestId)).kind).toBe('enrichment');
		const fresh = await propose(
			observed({ originRecordId: 'crossref:fresh-kind', fields: { title: 'Fresh Kind Work', type: 'article', category: 'secondary' } })
		);
		expect((await crRow(fresh.changeRequestId)).kind).toBe('new_source');
		await approve(enrich.changeRequestId, 0.9);
		await approve(fresh.changeRequestId, 0.9);

		const summary = await runApplyApproved(db, { kinds: ['new_source'] });
		expect(summary.selected).toBe(1);
		expect(summary.applied).toBe(1);
		expect(summary.newSources).toBe(1);
		expect(summary.enrichments).toBe(0);

		// the new_source applied; the enrichment CR is UNTOUCHED (still approved).
		expect((await crRow(fresh.changeRequestId)).status).toBe('applied');
		expect((await crRow(enrich.changeRequestId)).status).toBe('approved');
	});

	it('--min-llm-confidence drives only CRs at/above the bar (and skips those with no LLM review)', async () => {
		const hi = await propose(observed({ originRecordId: 'crossref:hi', fields: { title: 'High Conf', type: 'article', category: 'secondary' } }));
		const lo = await propose(observed({ originRecordId: 'crossref:lo', fields: { title: 'Low Conf', type: 'article', category: 'secondary' } }));
		const none = await propose(observed({ originRecordId: 'crossref:none', fields: { title: 'No Review', type: 'article', category: 'secondary' } }));
		await approve(hi.changeRequestId, 0.95);
		await approve(lo.changeRequestId, 0.6);
		await approve(none.changeRequestId); // no LLM review row

		const summary = await runApplyApproved(db, { minLlmConfidence: 0.9 });
		expect(summary.selected).toBe(1);
		expect(summary.applied).toBe(1);
		expect((await crRow(hi.changeRequestId)).status).toBe('applied');
		// below-bar + no-review CRs are left approved for a later, lower tier.
		expect((await crRow(lo.changeRequestId)).status).toBe('approved');
		expect((await crRow(none.changeRequestId)).status).toBe('approved');
	});

	it('confidenceBucket maps ranges (incl. "none" for no LLM review)', () => {
		expect(confidenceBucket(0.95)).toBe('≥0.9');
		expect(confidenceBucket(0.8)).toBe('0.75–0.9');
		expect(confidenceBucket(0.6)).toBe('0.5–0.75');
		expect(confidenceBucket(0.2)).toBe('<0.5');
		expect(confidenceBucket(null)).toBe('none');
	});
});
