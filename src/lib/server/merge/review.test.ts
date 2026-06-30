/**
 * Review path (Git-in-the-DB Phase 4) — `reviewChangeRequest` against a real
 * :memory: DB.
 *
 * Proves the §3 / §5 resolution policy:
 *   1. every verdict is APPENDED as one immutable `change_request_reviews` row;
 *   2. `needs_evidence` → CR `needs_evidence`, observation stays `proposed`
 *      (recoverable), ZERO canonical mutation;
 *   3. `reject` → CR `rejected` AND its observation `rejected` (one atomic batch),
 *      ZERO canonical mutation, both kept in the ledger;
 *   4. an LLM `apply` verdict is ADVISORY (default) → CR `approved`, NO canonical
 *      write — a human still has to apply;
 *   5. a HUMAN `apply` verdict drives `applyChangeRequest` → canonical written;
 *   6. the apply lock accepts a `needs_evidence` CR (a re-reviewed proposal applies).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from '../db/schema';
import { mergeSourceObservation, reviewChangeRequest } from './merge-source-observation';
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
	delete env.LLM_AUTOAPPROVE_CHANGE_REQUESTS;
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

/** an LLM enrichment that ATTACHES (shared DOI) but is low-trust ⇒ gate.propose */
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

async function counts() {
	return {
		sources: (await db.select().from(schema.sources)).length,
		observations: (await db.select().from(schema.sourceObservations)).length,
		diffs: (await db.select().from(schema.sourceObservationDiffs)).length,
		changeRequests: (await db.select().from(schema.changeRequests)).length,
		reviews: (await db.select().from(schema.changeRequestReviews)).length,
		provenance: (await db.select().from(schema.sourceFieldProvenance)).length,
		claims: (await db.select().from(schema.sourceFieldClaims)).length,
		links: (await db.select().from(schema.sourceLinks)).length
	};
}

/** seed one applied source carrying DOI 10.1234/seed (flag OFF ⇒ auto-apply). */
async function seedSource(): Promise<string> {
	const r = await mergeSourceObservation(
		db,
		observed({
			originRecordId: 'crossref:seed',
			identifiers: [{ kind: 'doi', value: '10.1234/seed' }]
		})
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

describe('reviewChangeRequest — verdict is appended, then the CR is acted on', () => {
	it('reject → CR rejected + observation rejected (atomic), ZERO canonical, ledger keeps both', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:reject' }));
		const before = await counts();

		const res = await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'reject',
			reason: 'spam'
		});
		expect(res.status).toBe('rejected');

		const after = await counts();
		expect(after.reviews - before.reviews).toBe(1); // one verdict appended
		expect(after.sources).toBe(before.sources); // ZERO canonical mutation
		expect(after.provenance).toBe(before.provenance);
		expect(after.claims).toBe(before.claims);

		const crow = await crStatus(cr.changeRequestId);
		expect(crow.status).toBe('rejected');
		expect(crow.decidedByActor).toBe('mod-1');
		expect(crow.decidedAt).not.toBeNull();
		// the observation is rejected but KEPT in the ledger (no-loss)
		const orow = await obsStatus(cr.observationId);
		expect(orow.status).toBe('rejected');
	});

	it('needs_evidence → CR needs_evidence, observation stays proposed (recoverable), no canonical', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:needsev' }));
		const before = await counts();

		const res = await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'needs_evidence',
			reason: 'please cite a source'
		});
		expect(res.status).toBe('needs_evidence');

		const after = await counts();
		expect(after.reviews - before.reviews).toBe(1);
		expect(after.sources).toBe(before.sources);

		expect((await crStatus(cr.changeRequestId)).status).toBe('needs_evidence');
		// the observation is NOT rejected — a needs_evidence CR can still be applied
		expect((await obsStatus(cr.observationId)).status).toBe('proposed');
	});

	it('an LLM apply verdict is ADVISORY → CR approved, ZERO canonical write', async () => {
		const sid = await seedSource();
		const cr = await propose(
			llmEnrichment({
				originRecordId: 'openalex:advisory',
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'LLM advisory' }
			})
		);
		const before = await counts();

		const res = await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'llm',
			reviewerActor: 'model-x',
			verdict: 'apply',
			confidence: 0.8,
			reason: 'looks well-sourced'
		});
		expect(res.status).toBe('approved');
		expect(res.applied).toBeUndefined(); // advisory — nothing was applied

		const after = await counts();
		expect(after.reviews - before.reviews).toBe(1);
		expect(after.sources).toBe(before.sources);
		expect(after.provenance).toBe(before.provenance);

		expect((await crStatus(cr.changeRequestId)).status).toBe('approved');
		// the LLM summary did NOT land — the proposal is still a proposal
		const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(src.summary).toBeNull();
		expect((await obsStatus(cr.observationId)).status).toBe('proposed');
	});

	it('a HUMAN apply verdict drives the merge — canonical written, CR + observation applied', async () => {
		const sid = await seedSource();
		const cr = await propose(
			llmEnrichment({
				originRecordId: 'openalex:human',
				fields: {
					title: 'A Work',
					type: 'article',
					category: 'secondary',
					summary: 'human-approved summary'
				}
			})
		);
		// LLM advises approve first (advisory) …
		await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'llm',
			reviewerActor: 'model-x',
			verdict: 'apply',
			reason: 'ok'
		});
		// … then a human applies.
		const res = await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'apply',
			reason: 'confirmed against the catalogue'
		});
		expect(res.status).toBe('applied');
		expect(['applied', 'partial']).toContain(res.applied?.status);

		expect((await crStatus(cr.changeRequestId)).status).toBe('applied');
		const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(src.summary).toBe('human-approved summary'); // canonical written
		expect((await obsStatus(cr.observationId)).status).toMatch(/applied|partial/);

		// BOTH verdicts kept in the append-only review ledger
		const reviews = await db
			.select()
			.from(schema.changeRequestReviews)
			.where(eq(schema.changeRequestReviews.changeRequestId, cr.changeRequestId));
		expect(reviews.length).toBe(2);
	});

	it('a human apply on a needs_evidence CR still applies (the lock accepts needs_evidence)', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:ne-apply' }));
		await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'needs_evidence',
			reason: 'hmm'
		});
		const res = await reviewChangeRequest(db, cr.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'apply',
			reason: 'evidence supplied'
		});
		expect(res.status).toBe('applied');
		expect((await crStatus(cr.changeRequestId)).status).toBe('applied');
	});
});
