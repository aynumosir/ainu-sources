/**
 * Propose path (Git-in-the-DB Phase 3) — against a real :memory: DB.
 *
 * Proves the three Phase-3 invariants:
 *   1. `openChangeRequest` writes EXACTLY three rows (the `proposed` observation,
 *      its `proposal` diff, the `open` change request) and ZERO canonical data
 *      (sources / provenance / claims / active links are untouched).
 *   2. With `SOURCES_ENABLE_PROPOSE` ON, a re-submitted `proposed` observation
 *      returns its EXISTING change request — no second CR is opened.
 *   3. With the flag OFF (production default), a `propose`-gated observation
 *      still AUTO-APPLIES — byte-identical to Phase 2 — so live creation is never
 *      routed into a queue that nothing drains yet (Phases 4-5).
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
	planSourceObservation,
	openChangeRequest,
	isEmptyDiffAttach
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
	// never leak the flag into another test in this file
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

/** seed one applied source carrying DOI 10.1234/seed + a link (flag OFF ⇒ auto-apply). */
async function seedSource(): Promise<string> {
	const r = await mergeSourceObservation(
		db,
		observed({
			originRecordId: 'crossref:seed',
			identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
			links: [{ type: 'pdf', url: 'https://example.org/seed.pdf' }]
		})
	);
	return r.sourceId!;
}

describe('openChangeRequest — writes exactly 3 rows, ZERO canonical mutation', () => {
	it('inserts the proposed observation + proposal diff + open CR and nothing else', async () => {
		const sid = await seedSource();
		const srcBefore = (
			await db.select().from(schema.sources).where(eq(schema.sources.id, sid))
		)[0];
		const before = await counts();

		// a simulated plan is the contract for openChangeRequest.
		const plan = await planSourceObservation(db, llmEnrichment({}), { simulate: true });
		expect(plan.gate.mode).toBe('propose');
		expect(plan.diff).not.toBeNull();

		const res = await openChangeRequest(db, plan);
		const after = await counts();

		// ── exactly three new rows ─────────────────────────────────────────────
		expect(after.observations - before.observations).toBe(1);
		expect(after.diffs - before.diffs).toBe(1);
		expect(after.changeRequests - before.changeRequests).toBe(1);

		// ── ZERO canonical mutation ────────────────────────────────────────────
		expect(after.sources).toBe(before.sources);
		expect(after.provenance).toBe(before.provenance);
		expect(after.claims).toBe(before.claims);
		expect(after.links).toBe(before.links);

		// the seeded source row is byte-identical (no contentHash / summary / ts drift)
		const srcAfter = (
			await db.select().from(schema.sources).where(eq(schema.sources.id, sid))
		)[0];
		expect(srcAfter.contentHash).toBe(srcBefore.contentHash);
		expect(srcAfter.summary).toBe(srcBefore.summary); // still null — the LLM summary did NOT land
		expect(srcAfter.updatedAt.getTime()).toBe(srcBefore.updatedAt.getTime());

		// ── the three rows are exactly as specified ────────────────────────────
		const [obs] = await db
			.select()
			.from(schema.sourceObservations)
			.where(eq(schema.sourceObservations.id, res.observationId));
		expect(obs.status).toBe('proposed');
		expect(typeof obs.matchDecision).toBe('string'); // plain text, never JSON-parsed
		expect(obs.payload).toBeTypeOf('object'); // round-trips as an object

		const [diff] = await db
			.select()
			.from(schema.sourceObservationDiffs)
			.where(eq(schema.sourceObservationDiffs.id, res.diffId));
		expect(diff.diffKind).toBe('proposal');
		expect(diff.observationId).toBe(res.observationId);
		expect(diff.sourceId).toBe(sid);
		expect(diff.diff).toBeTypeOf('object');

		const [cr] = await db
			.select()
			.from(schema.changeRequests)
			.where(eq(schema.changeRequests.id, res.changeRequestId));
		expect(cr.status).toBe('open');
		expect(cr.observationId).toBe(res.observationId);
		expect(cr.sourceId).toBe(sid);
		expect(cr.kind).toBe(plan.gate.kind);
		expect(cr.routingReason).toBe(plan.gate.reason);

		// the result shape
		expect(res.status).toBe('proposed');
		expect(res.sourceId).toBe(sid);
		expect(res.appliedClaims).toEqual([]);
		expect(res.lifecycleEvents).toEqual([]);
	});

	it('a brand-NEW-source proposal writes NO source row (isNewSource diff)', async () => {
		enablePropose();
		const before = await counts();
		const res = (await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:brand-new' })
		)) as ProposedMergeResult;
		const after = await counts();

		expect(res.status).toBe('proposed');
		expect(res.sourceId).toBeUndefined();
		expect(after.sources).toBe(before.sources); // no source materialized
		expect(after.observations - before.observations).toBe(1);
		expect(after.diffs - before.diffs).toBe(1);
		expect(after.changeRequests - before.changeRequests).toBe(1);

		const [diff] = await db
			.select()
			.from(schema.sourceObservationDiffs)
			.where(eq(schema.sourceObservationDiffs.id, res.diffId));
		expect(diff.isNewSource).toBe(true);
		expect(diff.sourceId).toBeNull();
		const [cr] = await db
			.select()
			.from(schema.changeRequests)
			.where(eq(schema.changeRequests.id, res.changeRequestId));
		expect(cr.kind).toBe('new_source');
	});
});

describe('duplicate-observation behavior (flag ON)', () => {
	it('a re-submitted proposed observation returns its EXISTING change request', async () => {
		enablePropose();
		await seedSource();
		const first = (await mergeSourceObservation(db, llmEnrichment({}))) as ProposedMergeResult;
		expect(first.status).toBe('proposed');
		const crCount1 = (await db.select().from(schema.changeRequests)).length;

		// identical payload ⇒ same (origin, recordId, contentHash) ⇒ duplicate.
		const second = (await mergeSourceObservation(db, llmEnrichment({}))) as ProposedMergeResult;
		const crCount2 = (await db.select().from(schema.changeRequests)).length;

		expect(second.status).toBe('proposed');
		expect(second.changeRequestId).toBe(first.changeRequestId); // SAME CR
		expect(second.observationId).toBe(first.observationId);
		expect(second.diffId).toBe(''); // dup return carries no fresh diff id
		expect(crCount2).toBe(crCount1); // NO second CR opened
	});
});

describe('flag OFF — propose-gated observation still AUTO-APPLIES (Phase-2 parity)', () => {
	it('a brand-new source (gate.propose) commits and opens NO change request', async () => {
		// flag intentionally left OFF (default)
		const r = await mergeSourceObservation(db, observed({ originRecordId: 'crossref:off-new' }));
		expect(r.gate?.mode).toBe('propose'); // gate still says propose…
		expect(r.status).toBe('applied'); // …but it auto-applies (fallback)
		expect(r.sourceId).toBeTruthy();
		expect((await db.select().from(schema.sources)).length).toBe(1);
		expect((await db.select().from(schema.changeRequests)).length).toBe(0); // no queue write
	});

	it('a low-trust enrichment (gate.propose) commits and opens NO change request', async () => {
		await seedSource();
		const r = await mergeSourceObservation(db, llmEnrichment({}));
		expect(r.gate?.mode).toBe('propose');
		expect(['applied', 'partial', 'noop']).toContain(r.status);
		expect((await db.select().from(schema.changeRequests)).length).toBe(0);
	});
});

describe('flag ON — auto_apply paths still commit canonical (not proposed)', () => {
	it('an editorial edit via targetSourceId applies (no CR) even with the flag on', async () => {
		enablePropose();
		// create through the propose flow first so the source exists.
		const created = (await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:edit-base' })
		)) as ProposedMergeResult;
		// brand-new ⇒ proposed; apply it by hand for the fixture is out of scope, so
		// instead seed a real source with the flag OFF, then flip the flag on.
		expect(created.status).toBe('proposed');

		delete env.SOURCES_ENABLE_PROPOSE;
		const sid = await seedSource();
		enablePropose();

		const r = await mergeSourceObservation(db, {
			origin: 'website',
			originRecordId: `website:${sid}`,
			targetSourceId: sid,
			derivation: 'editorial_decision',
			confidence: 1,
			evidence: 1,
			fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'editorial' }
		});
		expect(r.gate?.mode).toBe('auto_apply');
		expect(r.status).toBe('applied');
		// editorial edit is NOT proposed — it committed canonical data.
		const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(src.summary).toBe('editorial');
	});
});

describe('empty-diff short-circuit — a would-be-noop attach is a noop, not a proposal', () => {
	/** an extracted/curated-style re-observation that ATTACHES via the seed's strong
	 *  id but carries EXACTLY the seed's fields ⇒ the merge changes nothing. Low-trust
	 *  derivation keeps the gate at `propose` even on a clean attach, isolating the
	 *  empty-diff short-circuit from the gate decision. */
	const noopReobservation = (over: Partial<MergeInput>): MergeInput => ({
		origin: 'openalex',
		originRecordId: 'openalex:noop-1',
		derivation: 'llm_extraction',
		confidence: 0.9,
		evidence: 2,
		identifiers: [{ kind: 'doi', value: '10.1234/seed' }],
		fields: { title: 'A Work', type: 'article', category: 'secondary' },
		...over
	});

	it('a propose-gated attach with an EMPTY diff → noop, 0 change requests, observation recorded', async () => {
		await seedSource(); // flag OFF ⇒ the seed auto-applies (a real, attachable source)
		enablePropose();
		const before = await counts();

		// the plan the router sees: propose-gated, attaches to the seed, empty diff.
		const plan = await planSourceObservation(db, noopReobservation({}), { simulate: true });
		expect(plan.gate.mode).toBe('propose');
		expect(plan.gate.kind).not.toBe('identity_conflict');
		expect(plan.identity.action).toBe('attach');
		expect(plan.diff?.changedScalarFields).toEqual([]);
		expect(plan.diff?.changedCollections).toEqual([]);
		expect(isEmptyDiffAttach(plan)).toBe(true);

		const r = await mergeSourceObservation(db, noopReobservation({}));
		const after = await counts();

		expect(r.status).toBe('noop');
		expect(after.changeRequests).toBe(before.changeRequests); // NO proposal opened
		expect(after.diffs).toBe(before.diffs); // NO diff row written
		expect(after.observations - before.observations).toBe(1); // observation IS recorded (idempotency/audit)
		// ── ZERO canonical mutation ──
		expect(after.sources).toBe(before.sources);
		expect(after.provenance).toBe(before.provenance);
		expect(after.claims).toBe(before.claims);
		expect(after.links).toBe(before.links);

		// the recorded observation is a `noop` in the ledger
		const [obs] = await db
			.select()
			.from(schema.sourceObservations)
			.where(eq(schema.sourceObservations.id, r.observationId));
		expect(obs.status).toBe('noop');

		// a SECOND identical run dedupes (same origin/recordId/contentHash) ⇒ still a
		// noop, opens nothing, records no new observation (idempotent).
		const r2 = await mergeSourceObservation(db, noopReobservation({}));
		const after2 = await counts();
		expect(r2.status).toBe('noop');
		expect(after2.changeRequests).toBe(before.changeRequests);
		expect(after2.observations).toBe(after.observations);
	});

	it('a propose-gated attach WITH a real scalar change → still opens a change request', async () => {
		await seedSource(); // flag OFF ⇒ the seed auto-applies (a real, attachable source)
		enablePropose();
		const before = await counts();

		// same clean attach, but now it adds a NEW field (summary) ⇒ non-empty diff.
		const plan = await planSourceObservation(
			db,
			noopReobservation({
				originRecordId: 'openalex:enrich-real',
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'a new summary' }
			}),
			{ simulate: true }
		);
		expect(plan.gate.mode).toBe('propose');
		expect(plan.diff?.changedScalarFields).toContain('summary');
		expect(isEmptyDiffAttach(plan)).toBe(false);

		const r = (await mergeSourceObservation(
			db,
			noopReobservation({
				originRecordId: 'openalex:enrich-real',
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'a new summary' }
			})
		)) as ProposedMergeResult;
		const after = await counts();
		expect(r.status).toBe('proposed');
		expect(after.changeRequests - before.changeRequests).toBe(1); // real enrichment IS proposed
	});

	it('a new_source proposal is NOT an empty-diff noop (still proposes)', async () => {
		enablePropose();
		const before = await counts();

		const plan = await planSourceObservation(
			db,
			observed({ originRecordId: 'crossref:new-not-noop' }),
			{ simulate: true }
		);
		expect(plan.gate.kind).toBe('new_source');
		expect(isEmptyDiffAttach(plan)).toBe(false);

		const r = (await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:new-not-noop' })
		)) as ProposedMergeResult;
		const after = await counts();
		expect(r.status).toBe('proposed');
		expect(after.changeRequests - before.changeRequests).toBe(1);
		expect(after.sources).toBe(before.sources); // no canonical source materialized
	});

	it('an identity_conflict proposal is NOT an empty-diff noop (propose even when values match)', async () => {
		// two applied sources, each carrying a DISTINCT strong id (flag OFF ⇒ auto-apply).
		const s1 = (
			await mergeSourceObservation(
				db,
				observed({ originRecordId: 'crossref:c1', identifiers: [{ kind: 'doi', value: '10.1234/aaa' }] })
			)
		).sourceId!;
		const s2 = (
			await mergeSourceObservation(
				db,
				observed({ originRecordId: 'crossref:c2', identifiers: [{ kind: 'doi', value: '10.5678/bbb' }] })
			)
		).sourceId!;
		expect(s1).not.toBe(s2);

		enablePropose();
		const before = await counts();
		// one observation carrying BOTH strong ids ⇒ strong_multi ⇒ identity conflict —
		// even though its fields exactly match the two sources' values.
		const conflicting = observed({
			originRecordId: 'crossref:conflict',
			identifiers: [
				{ kind: 'doi', value: '10.1234/aaa' },
				{ kind: 'doi', value: '10.5678/bbb' }
			]
		});
		const plan = await planSourceObservation(db, conflicting, { simulate: true });
		expect(plan.gate.mode).toBe('propose');
		expect(plan.gate.kind).toBe('identity_conflict');
		expect(isEmptyDiffAttach(plan)).toBe(false);

		const r = (await mergeSourceObservation(db, conflicting)) as ProposedMergeResult;
		const after = await counts();
		expect(r.status).toBe('proposed');
		expect(after.changeRequests - before.changeRequests).toBe(1);
	});
});
