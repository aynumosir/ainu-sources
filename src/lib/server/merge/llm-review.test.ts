/**
 * LLM reviewer (Git-in-the-DB Phase 6) — against a real :memory: DB, with a
 * MOCKED reviewer client (NO network, ever).
 *
 * Proves the §5 resolution policy + the safe-enrichment auto-approve predicate:
 *   1. buildLlmReviewContext returns the §5 shape (diff, observation, current
 *      provenance, rules block);
 *   2. strict output validation rejects malformed reviewer responses (whole review);
 *   3. flag ON + safe-enrichment predicate → applyChangeRequest ran, canonical written;
 *   4. new_source / conflict / low-conf / low-LLM-conf / strong-id → advisory only
 *      (CR 'approved', NO canonical write) EVEN with the flag on;
 *   5. flag OFF → always advisory (byte-identical to Phase-4).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from '../db/schema';
import { mergeSourceObservation } from './merge-source-observation';
import {
	buildLlmReviewContext,
	callLlmReviewer,
	validateLlmReviewOutput,
	isSafeEnrichment,
	reviewProposalWithLLM,
	LlmReviewSchemaError,
	type LlmReviewClient,
	type LlmReviewOutput
} from './llm-review';
import type { MergeInput, ProposedMergeResult } from './types';

const MIGRATIONS = fileURLToPath(new URL('../../../../drizzle', import.meta.url));
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
	delete env.LLM_AUTOAPPROVE_CHANGE_REQUESTS;
});

const enablePropose = () => {
	env.SOURCES_ENABLE_PROPOSE = 'true';
};
const enableAutoApprove = () => {
	env.SOURCES_LLM_AUTOAPPROVE = 'true';
};

/** a fake reviewer client — no network, returns a fixed (raw) response object. */
const fakeClient = (raw: unknown): LlmReviewClient => async () => raw;

const applyVerdict = (over?: Partial<LlmReviewOutput>): LlmReviewOutput => ({
	verdict: 'apply',
	confidence: 0.95,
	reason: 'well-sourced enrichment',
	...over
});

const observed = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'crossref',
	originRecordId: 'crossref:base',
	derivation: 'observed',
	confidence: 0.9,
	fields: { title: 'A Work', type: 'article', category: 'secondary' },
	...over
});

/** an INFERRED enrichment that ATTACHES via a shared DOI (strong_single) but is
 *  low-trust ⇒ gate.propose(enrichment). Not an LLM assertion ⇒ safe-eligible. */
const inferredEnrichment = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'openalex',
	originRecordId: 'openalex:enrich-1',
	derivation: 'inferred',
	confidence: 0.9,
	evidence: 2,
	identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
	fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'an enrichment summary' },
	...over
});

/** an LLM enrichment sharing the DOI — llm_extraction asserting a strong id ⇒ the
 *  audit-gate mirror flags it ⇒ NOT a safe enrichment (strong-id case). */
const llmStrongIdEnrichment = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'openalex',
	originRecordId: 'openalex:llm-strongid',
	derivation: 'llm_extraction',
	confidence: 0.9,
	evidence: 2,
	identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
	fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'llm summary' },
	...over
});

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

const crStatus = async (id: string) =>
	(await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)))[0];
const obsStatus = async (id: string) =>
	(await db.select().from(schema.sourceObservations).where(eq(schema.sourceObservations.id, id)))[0];
const srcById = async (id: string) =>
	(await db.select().from(schema.sources).where(eq(schema.sources.id, id)))[0];
const reviewCount = async (crId: string) =>
	(
		await db
			.select()
			.from(schema.changeRequestReviews)
			.where(eq(schema.changeRequestReviews.changeRequestId, crId))
	).length;

// ── 1. context builder ──────────────────────────────────────────────────────

describe('buildLlmReviewContext — §5 shape', () => {
	it('assembles the change request, diff, observation, current provenance, and rules', async () => {
		const sid = await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:ctx' }));

		const ctx = await buildLlmReviewContext(db, cr.changeRequestId);

		expect(ctx.changeRequest.id).toBe(cr.changeRequestId);
		expect(ctx.changeRequest.kind).toBe('enrichment');
		expect(ctx.changeRequest.derivation).toBe('inferred');
		expect(ctx.changeRequest.confidence).toBe(0.9);
		// the diff is the stored before→after preview, with summary lines.
		expect(ctx.diff.summaryLines.length).toBeGreaterThan(0);
		expect(ctx.diff.isNewSource).toBe(false);
		expect(ctx.diff.sourceId).toBe(sid);
		// the observation payload + strong-single match decision.
		expect(ctx.observation.matchDecision).toBe('strong_single');
		expect(ctx.observation.payload).toBeTruthy();
		// current provenance for the seeded source (title/type/category were set).
		expect(ctx.currentProvenance.length).toBeGreaterThan(0);
		// the rules block mirrors audit-gate.
		expect(ctx.rules.noFabrication).toBe(true);
		expect(ctx.rules.llmCannotAssertStrongIdentifiers).toBe(true);
		expect(ctx.rules.reviewerVerdictDoesNotChangeRank).toBe(true);
		expect(ctx.rules.llmCannotSetWithoutEvidence).toEqual(
			expect.arrayContaining(['holdingInstitution', 'callNumber', 'yearStart', 'yearEnd'])
		);
	});

	it('throws for an unknown change request', async () => {
		await expect(buildLlmReviewContext(db, 'does-not-exist')).rejects.toThrow();
	});
});

// ── 2. strict output validation ─────────────────────────────────────────────

describe('validateLlmReviewOutput — rejects malformed responses', () => {
	it('accepts a well-formed apply verdict', () => {
		const out = validateLlmReviewOutput({ verdict: 'apply', confidence: 0.9, reason: 'ok' });
		expect(out.verdict).toBe('apply');
	});
	it('rejects an invalid verdict', () => {
		expect(() => validateLlmReviewOutput({ verdict: 'maybe', confidence: 0.9, reason: 'x' })).toThrow(
			LlmReviewSchemaError
		);
	});
	it('rejects confidence out of [0,1]', () => {
		expect(() => validateLlmReviewOutput({ verdict: 'apply', confidence: 2, reason: 'x' })).toThrow(
			LlmReviewSchemaError
		);
	});
	it('rejects an empty reason', () => {
		expect(() => validateLlmReviewOutput({ verdict: 'apply', confidence: 0.9, reason: '   ' })).toThrow(
			LlmReviewSchemaError
		);
	});
	it('rejects a non-object', () => {
		expect(() => validateLlmReviewOutput('nope')).toThrow(LlmReviewSchemaError);
	});
	it('rejects malformed evidenceRefs / fieldNotes', () => {
		expect(() =>
			validateLlmReviewOutput({ verdict: 'apply', confidence: 0.9, reason: 'x', evidenceRefs: [1, 2] })
		).toThrow(LlmReviewSchemaError);
		expect(() =>
			validateLlmReviewOutput({
				verdict: 'apply',
				confidence: 0.9,
				reason: 'x',
				fieldNotes: [{ field: 'summary', verdict: 'nope', reason: 'r' }]
			})
		).toThrow(LlmReviewSchemaError);
	});
	it('callLlmReviewer rejects the whole review on a schema violation', async () => {
		const sid = await seedSource();
		void sid;
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:bad' }));
		const ctx = await buildLlmReviewContext(db, cr.changeRequestId);
		await expect(
			callLlmReviewer(ctx, { client: fakeClient({ verdict: 'apply', confidence: 5, reason: '' }) })
		).rejects.toThrow(LlmReviewSchemaError);
	});
});

// ── 3. safe-enrichment auto-apply (flag ON + predicate holds) ────────────────

describe('reviewProposalWithLLM — safe-enrichment auto-apply', () => {
	it('flag ON + predicate holds → applyChangeRequest ran, canonical written', async () => {
		const sid = await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:safe' }));
		expect((await srcById(sid)).summary).toBeNull(); // nothing applied yet

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.output.verdict).toBe('apply');
		expect(res.safeEnrichment).toBe(true);
		expect(res.autoApplied).toBe(true);
		expect(res.review.status).toBe('approved'); // reviewChangeRequest recorded advisory first
		expect(await reviewCount(cr.changeRequestId)).toBe(1); // exactly one verdict appended

		// canonical WAS written through the merge engine.
		expect((await crStatus(cr.changeRequestId)).status).toBe('applied');
		expect((await srcById(sid)).summary).toBe('an enrichment summary');
		expect((await obsStatus(cr.observationId)).status).toMatch(/applied|partial/);
		// reviewer is recorded as the model, audit-only.
		const [review] = await db
			.select()
			.from(schema.changeRequestReviews)
			.where(eq(schema.changeRequestReviews.changeRequestId, cr.changeRequestId));
		expect(review.reviewerKind).toBe('llm');
		expect(review.reviewerActor).toBe('claude-sonnet-4-6');
	});
});

// ── 4. advisory-only cases EVEN with the flag on ────────────────────────────

describe('reviewProposalWithLLM — advisory only even with the flag ON', () => {
	it('strong-id assertion (llm_extraction + DOI) → advisory, no canonical write', async () => {
		const sid = await seedSource();
		const cr = await propose(llmStrongIdEnrichment({ originRecordId: 'openalex:strongid' }));

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.safeEnrichment).toBe(false);
		expect(res.autoApplied).toBe(false);
		expect(res.review.status).toBe('approved');
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await srcById(sid)).summary).toBeNull(); // NO canonical write
		expect((await obsStatus(cr.observationId)).status).toBe('proposed');
	});

	it('low observation confidence (< 0.85) → advisory, no canonical write', async () => {
		const sid = await seedSource();
		const cr = await propose(
			inferredEnrichment({ originRecordId: 'openalex:lowconf', confidence: 0.5 })
		);

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.safeEnrichment).toBe(false);
		expect(res.autoApplied).toBe(false);
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await srcById(sid)).summary).toBeNull();
	});

	it('low reviewer confidence (< 0.85) → advisory, no canonical write', async () => {
		const sid = await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:lowllm' }));

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict({ confidence: 0.5 }))
		});

		expect(res.safeEnrichment).toBe(false);
		expect(res.autoApplied).toBe(false);
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await srcById(sid)).summary).toBeNull();
	});

	it('new_source proposal → advisory, no source created', async () => {
		const before = (await db.select().from(schema.sources)).length;
		const cr = await propose(
			observed({
				origin: 'openalex',
				originRecordId: 'openalex:newsrc',
				derivation: 'llm_extraction',
				evidence: 2,
				identifiers: [],
				fields: { title: 'A Brand New Work', type: 'article', category: 'secondary' }
			})
		);
		expect((await crStatus(cr.changeRequestId)).kind).toBe('new_source');

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.safeEnrichment).toBe(false);
		expect(res.autoApplied).toBe(false);
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await db.select().from(schema.sources)).length).toBe(before); // NO source created
	});

	it('conflict proposal → advisory, no canonical write', async () => {
		const sid = await seedSource();
		// a second `observed` sharing the DOI but with a DIFFERENT title ⇒ same-band
		// predicted conflict on title ⇒ gate.propose(identity_conflict).
		const cr = await propose(
			observed({
				originRecordId: 'crossref:conflict',
				identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
				fields: { title: 'A DIFFERENT Work', type: 'article', category: 'secondary' }
			})
		);
		expect((await crStatus(cr.changeRequestId)).kind).toBe('identity_conflict');
		const titleBefore = (await srcById(sid)).title;

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.safeEnrichment).toBe(false);
		expect(res.autoApplied).toBe(false);
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await srcById(sid)).title).toBe(titleBefore); // unchanged
	});

	it('needs_evidence verdict → CR needs_evidence, no canonical write', async () => {
		const sid = await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:needsev' }));

		enableAutoApprove();
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient({ verdict: 'needs_evidence', confidence: 0.9, reason: 'cite a source' })
		});

		expect(res.autoApplied).toBe(false);
		expect(res.review.status).toBe('needs_evidence');
		expect((await crStatus(cr.changeRequestId)).status).toBe('needs_evidence');
		expect((await srcById(sid)).summary).toBeNull();
	});
});

// ── 5. flag OFF → always advisory (byte-identical to Phase-4) ────────────────

describe('reviewProposalWithLLM — flag OFF is always advisory', () => {
	it('a safe enrichment stays advisory when SOURCES_LLM_AUTOAPPROVE is off', async () => {
		const sid = await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:flagoff' }));

		// flag deliberately NOT set.
		const res = await reviewProposalWithLLM(db, cr.changeRequestId, {
			client: fakeClient(applyVerdict())
		});

		expect(res.safeEnrichment).toBe(true); // the predicate would hold …
		expect(res.autoApplied).toBe(false); // … but the flag gates it off.
		expect(res.review.status).toBe('approved');
		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		expect((await srcById(sid)).summary).toBeNull(); // NO canonical write
		expect((await obsStatus(cr.observationId)).status).toBe('proposed');
	});
});

// ── isSafeEnrichment unit coverage (pure predicate) ─────────────────────────

describe('isSafeEnrichment — pure predicate', () => {
	it('is false for any non-apply verdict', async () => {
		await seedSource();
		const cr = await propose(inferredEnrichment({ originRecordId: 'openalex:pred' }));
		const ctx = await buildLlmReviewContext(db, cr.changeRequestId);
		expect(isSafeEnrichment(ctx, { verdict: 'reject', confidence: 0.99, reason: 'x' })).toBe(false);
		expect(isSafeEnrichment(ctx, { verdict: 'apply', confidence: 0.99, reason: 'x' })).toBe(true);
	});
});
