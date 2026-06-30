/**
 * Apply path (Git-in-the-DB Phase 4) — `applyChangeRequest` against a real
 * :memory: DB. The "merge the PR" engine: lock → re-plan live → commit reusing
 * the proposed observation → finalize.
 *
 * Proves:
 *   1. APPLY ONCE — a propose→apply round trip writes canonical data (sources +
 *      claims + provenance), flips the CR to `applied` and its observation
 *      `proposed`→`applied`, and writes the second ('applied') diff alongside the
 *      'proposal' one.
 *   2. IDEMPOTENT — re-applying converges: the lock returns the recorded result and
 *      writes ZERO new rows (no duplicate source / claims / diff).
 *   3. THE LOCK PREVENTS DOUBLE-APPLY — a CR already in `applying` is stale.
 *   4. RE-PLAN REBASE — a CR that became conflicting between propose and apply
 *      bounces to `needs_evidence` and never clobbers the live winner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from '../db/schema';
import {
	mergeSourceObservation,
	applyChangeRequest,
	ChangeRequestStale
} from './merge-source-observation';
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

async function counts() {
	return {
		sources: (await db.select().from(schema.sources)).length,
		observations: (await db.select().from(schema.sourceObservations)).length,
		diffs: (await db.select().from(schema.sourceObservationDiffs)).length,
		changeRequests: (await db.select().from(schema.changeRequests)).length,
		provenance: (await db.select().from(schema.sourceFieldProvenance)).length,
		claims: (await db.select().from(schema.sourceFieldClaims)).length,
		links: (await db.select().from(schema.sourceLinks)).length,
		revisions: (await db.select().from(schema.sourceRevisions)).length
	};
}

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

const crRow = async (id: string) =>
	(await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)))[0];
const obsRow = async (id: string) =>
	(await db.select().from(schema.sourceObservations).where(eq(schema.sourceObservations.id, id)))[0];

describe('applyChangeRequest — applies once, writes canonical, flips the ledger', () => {
	it('a new-source CR applies: source created, CR applied, observation flipped, applied diff written', async () => {
		const cr = await propose(
			observed({
				originRecordId: 'crossref:new-apply',
				fields: { title: 'New Apply Work', type: 'article', category: 'secondary' }
			})
		);
		// no canonical yet — a proposal mutates ZERO canonical data
		expect((await db.select().from(schema.sources)).length).toBe(0);

		const res = await applyChangeRequest(db, cr.changeRequestId, 'human-1');
		expect(res.status).toBe('applied');
		expect(res.sourceId).toBeTruthy();

		// the source NOW exists in canonical
		const srcs = await db.select().from(schema.sources);
		expect(srcs.length).toBe(1);
		expect(srcs[0].title).toBe('New Apply Work');
		expect(srcs[0].id).toBe(res.sourceId);

		// claims + provenance written through the SAME engine
		expect((await db.select().from(schema.sourceFieldProvenance)).length).toBeGreaterThan(0);
		expect((await db.select().from(schema.sourceFieldClaims)).length).toBeGreaterThan(0);

		// CR finalized
		const crow = await crRow(cr.changeRequestId);
		expect(crow.status).toBe('applied');
		expect(crow.appliedObservationStatus).toBe('applied');
		expect(crow.sourceId).toBe(res.sourceId);
		expect(crow.decidedByActor).toBe('human-1');
		expect(crow.decidedAt).not.toBeNull();

		// observation flipped proposed → applied
		expect((await obsRow(cr.observationId)).status).toBe('applied');

		// BOTH diffs now exist for this observation: the original 'proposal' + the new 'applied'
		const diffs = await db
			.select()
			.from(schema.sourceObservationDiffs)
			.where(eq(schema.sourceObservationDiffs.observationId, cr.observationId));
		expect(diffs.map((d) => d.diffKind).sort()).toEqual(['applied', 'proposal']);
	});

	it('re-applying converges to a NOOP: same result, ZERO new rows (idempotent)', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:new-idem' }));
		const first = await applyChangeRequest(db, cr.changeRequestId, 'human-1');
		const snap = await counts();
		const firstSrc = (await db.select().from(schema.sources))[0];

		const second = await applyChangeRequest(db, cr.changeRequestId, 'human-2');
		expect(second.status).toBe(first.status);
		expect(second.sourceId).toBe(first.sourceId);
		expect(second.observationId).toBe(first.observationId);

		// not one new row — the lock made the second apply return the recorded result
		expect(await counts()).toEqual(snap);
		const secondSrc = (await db.select().from(schema.sources))[0];
		expect(secondSrc.contentHash).toBe(firstSrc.contentHash);
		expect(secondSrc.updatedAt.getTime()).toBe(firstSrc.updatedAt.getTime()); // not re-touched

		// the recorded decider is the FIRST applier (no re-finalize on the idempotent return)
		expect((await crRow(cr.changeRequestId)).decidedByActor).toBe('human-1');
	});
});

describe('the lock prevents double-apply / a stale CR is a 409', () => {
	it('a CR already in "applying" (a concurrent worker holds the lock) is stale', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:lock' }));
		// simulate a concurrent worker holding the lock
		await db
			.update(schema.changeRequests)
			.set({ status: 'applying' })
			.where(eq(schema.changeRequests.id, cr.changeRequestId));

		await expect(applyChangeRequest(db, cr.changeRequestId)).rejects.toBeInstanceOf(
			ChangeRequestStale
		);
		// the lock refused — no canonical leaked
		expect((await db.select().from(schema.sources)).length).toBe(0);
		expect((await crRow(cr.changeRequestId)).status).toBe('applying');
	});

	it('applying a rejected CR is stale (never resurrects a decided CR)', async () => {
		const cr = await propose(observed({ originRecordId: 'crossref:rejected-apply' }));
		await db
			.update(schema.changeRequests)
			.set({ status: 'rejected' })
			.where(eq(schema.changeRequests.id, cr.changeRequestId));
		await expect(applyChangeRequest(db, cr.changeRequestId)).rejects.toBeInstanceOf(
			ChangeRequestStale
		);
		expect((await db.select().from(schema.sources)).length).toBe(0);
	});
});

describe('re-plan rebase — a CR that became conflicting bounces to needs_evidence', () => {
	it('a now same-band-conflicting field bounces (ChangeRequestStale) and never clobbers the live winner', async () => {
		const sid = await seedSource(); // DOI seed, no summary yet
		// open a CR enriching `summary` — empty at propose ⇒ will_apply ⇒ low-trust propose
		const cr = await propose(
			llmEnrichment({
				originRecordId: 'openalex:conf-a',
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'LLM A' }
			})
		);

		// meanwhile a SAME-RANK observation lands a DIFFERENT summary (flag OFF ⇒ auto-applies)
		delete env.SOURCES_ENABLE_PROPOSE;
		await mergeSourceObservation(
			db,
			llmEnrichment({
				originRecordId: 'openalex:conf-b',
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'Existing B' }
			})
		);
		const [mid] = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(mid.summary).toBe('Existing B');

		// applying the stale CR now detects the same-band conflict and bounces it
		await expect(applyChangeRequest(db, cr.changeRequestId, 'mod-1')).rejects.toBeInstanceOf(
			ChangeRequestStale
		);
		expect((await crRow(cr.changeRequestId)).status).toBe('needs_evidence');

		// the live winner was NOT clobbered — no dangerous apply happened
		const [after] = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(after.summary).toBe('Existing B');
		// the observation stays proposed (recoverable for re-review)
		expect((await obsRow(cr.observationId)).status).toBe('proposed');
	});
});
