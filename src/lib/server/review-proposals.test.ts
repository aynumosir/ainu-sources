/**
 * scripts/review-proposals.ts — runner (Git-in-the-DB Phase 6).
 *
 * Exercises the exported {@link runReviewProposals} core against a real :memory:
 * DB with a FAKE reviewer client (NO network). Proves:
 *   1. --dry-run evaluates the would-be verdicts and records NOTHING;
 *   2. the live run records advisory reviews (and auto-applies a safe enrichment
 *      when the flag is on);
 *   3. a CR already carrying an `llm` review is SKIPPED unless `--force`.
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
import type { LlmReviewClient } from './merge/llm-review';
import { runReviewProposals } from '../../../scripts/review-proposals';

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
	delete env.SOURCES_LLM_AUTOAPPROVE;
});

const fakeApply: LlmReviewClient = async () => ({
	verdict: 'apply',
	confidence: 0.95,
	reason: 'well-sourced enrichment'
});

/** keeps the CR in the reviewable queue (needs_evidence) so the skip path is testable. */
const fakeNeedsEvidence: LlmReviewClient = async () => ({
	verdict: 'needs_evidence',
	confidence: 0.6,
	reason: 'please cite a corroborating source'
});

async function seedSource(): Promise<string> {
	const r = await mergeSourceObservation(db, {
		origin: 'crossref',
		originRecordId: 'crossref:seed',
		derivation: 'observed',
		confidence: 0.9,
		identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
		fields: { title: 'A Work', type: 'article', category: 'secondary' }
	});
	return r.sourceId!;
}

async function proposeEnrichment(): Promise<ProposedMergeResult> {
	env.SOURCES_ENABLE_PROPOSE = 'true';
	const input: MergeInput = {
		origin: 'openalex',
		originRecordId: 'openalex:enrich-1',
		derivation: 'inferred',
		confidence: 0.9,
		evidence: 2,
		identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
		fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'an enrichment summary' }
	};
	const r = (await mergeSourceObservation(db, input)) as ProposedMergeResult;
	expect(r.status).toBe('proposed');
	return r;
}

const srcById = async (id: string) =>
	(await db.select().from(schema.sources).where(eq(schema.sources.id, id)))[0];

describe('runReviewProposals — dry-run records nothing', () => {
	it('--dry-run reports the would-be verdict and writes no review / no canonical', async () => {
		const sid = await seedSource();
		const cr = await proposeEnrichment();

		const summary = await runReviewProposals(db, { dryRun: true, client: fakeApply });

		expect(summary.dryRun).toBe(true);
		expect(summary.considered).toBe(1);
		expect(summary.reviewed).toBe(1);
		expect(summary.verdicts.apply).toBe(1);
		const item = summary.results[0];
		expect(item.status).toBe('dry-run');
		expect(item.verdict).toBe('apply');
		expect(item.safeEnrichment).toBe(true);
		// flag off ⇒ would NOT auto-apply.
		expect(item.wouldAutoApply).toBe(false);

		// NOTHING was recorded: no review row, CR still open, no canonical write.
		expect((await db.select().from(schema.changeRequestReviews)).length).toBe(0);
		expect(
			(await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, cr.changeRequestId)))[0]
				.status
		).toBe('open');
		expect((await srcById(sid)).summary).toBeNull();
	});

	it('--dry-run flags a safe enrichment as would-auto-apply when the flag is on', async () => {
		await seedSource();
		await proposeEnrichment();
		env.SOURCES_LLM_AUTOAPPROVE = 'true';

		const summary = await runReviewProposals(db, { dryRun: true, client: fakeApply });
		expect(summary.results[0].wouldAutoApply).toBe(true);
		// still recorded nothing.
		expect((await db.select().from(schema.changeRequestReviews)).length).toBe(0);
	});
});

describe('runReviewProposals — live run records + skips already-reviewed', () => {
	it('records an advisory review, then SKIPS it on a second run (unless --force)', async () => {
		const sid = await seedSource();
		const cr = await proposeEnrichment();

		// first live run → a needs_evidence verdict keeps the CR in the reviewable
		// queue AND records an llm review, no canonical write.
		const first = await runReviewProposals(db, { client: fakeNeedsEvidence });
		expect(first.reviewed).toBe(1);
		expect(first.skipped).toBe(0);
		expect(first.verdicts.needs_evidence).toBe(1);
		expect((await db.select().from(schema.changeRequestReviews)).length).toBe(1);
		expect((await srcById(sid)).summary).toBeNull();

		// second run → the CR (still needs_evidence) already carries an llm review ⇒ skipped.
		const second = await runReviewProposals(db, { client: fakeNeedsEvidence });
		expect(second.considered).toBe(1);
		expect(second.skipped).toBe(1);
		expect(second.reviewed).toBe(0);
		expect((await db.select().from(schema.changeRequestReviews)).length).toBe(1); // no new review

		// --force re-reviews (appends a second review).
		const forced = await runReviewProposals(db, { client: fakeNeedsEvidence, force: true });
		expect(forced.reviewed).toBe(1);
		expect((await db.select().from(schema.changeRequestReviews)).length).toBe(2);
		void cr;
	});

	it('flag ON → a live run auto-applies a safe enrichment (canonical written)', async () => {
		const sid = await seedSource();
		await proposeEnrichment();
		env.SOURCES_LLM_AUTOAPPROVE = 'true';

		const summary = await runReviewProposals(db, { client: fakeApply });
		expect(summary.autoApplied).toBe(1);
		expect((await srcById(sid)).summary).toBe('an enrichment summary');
	});
});
