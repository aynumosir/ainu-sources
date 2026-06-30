/**
 * Gate WIRING + Phase-2 behaviour-preservation, against a real :memory: DB.
 *
 * Proves the computed gate is surfaced on MergeResult AND that — in Phase 2 —
 * every non-duplicate path still COMMITS: a `propose` verdict falls back to
 * auto-apply (no change_requests table yet), so a brand-new source and a
 * low-trust enrichment both still land. Also smoke-tests the opt-in proposal
 * simulation produced by planSourceObservation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
	mergeSourceObservation,
	planSourceObservation,
	commitMerge
} from './merge-source-observation';
import type { MergeInput } from './types';

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

const observed = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'crossref',
	originRecordId: 'crossref:base',
	derivation: 'observed',
	confidence: 0.9,
	fields: { title: 'A Work', type: 'article', category: 'secondary' },
	...over
});

describe('gate wiring (Phase 2 — computed, not yet routed)', () => {
	it('brand-NEW source ⇒ gate.propose, but STILL commits (auto-apply fallback)', async () => {
		const r = await mergeSourceObservation(db, observed({ originRecordId: 'crossref:new-1' }));
		// the gate says "propose" (new additions are reviewed)…
		expect(r.gate?.mode).toBe('propose');
		expect(r.gate?.kind).toBe('new_source');
		// …but Phase 2 falls back to commit, so the source is materialized.
		expect(r.status).toBe('applied');
		expect(r.sourceId).toBeTruthy();
		expect((await db.select().from(schema.sources)).length).toBe(1);
	});

	it('strong-id harvest attaching cleanly ⇒ gate.auto_apply and applies', async () => {
		const withDoi = observed({
			originRecordId: 'crossref:doi-1',
			identifiers: [{ kind: 'doi', value: '10.1234/x' }]
		});
		await mergeSourceObservation(db, withDoi); // create
		// a materially different second observation of the same DOI attaches.
		const r = await mergeSourceObservation(
			db,
			observed({
				originRecordId: 'crossref:doi-2',
				identifiers: [{ kind: 'doi', value: '10.1234/x' }],
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'added' }
			})
		);
		expect(r.gate?.mode).toBe('auto_apply');
		expect(r.gate?.reason).toBe('strong_match_harvest');
		expect(r.status).toBe('applied');
	});

	it('editorial edit via targetSourceId ⇒ gate.auto_apply (editorial_edit)', async () => {
		const created = await mergeSourceObservation(db, observed({ originRecordId: 'crossref:ed-1' }));
		const sid = created.sourceId!;
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
		expect(r.gate?.reason).toBe('editorial_edit');
		expect(r.status).toBe('applied');
	});

	it('low-trust llm_extraction (with evidence) ⇒ gate.propose, still commits', async () => {
		await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:llm-base', identifiers: [{ kind: 'doi', value: '10.5678/y' }] })
		);
		const r = await mergeSourceObservation(db, {
			origin: 'openalex',
			originRecordId: 'openalex:llm-1',
			derivation: 'llm_extraction',
			confidence: 0.9,
			evidence: 2,
			identifiers: [{ kind: 'doi', value: '10.5678/y' }],
			fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'llm note' }
		});
		expect(r.gate?.mode).toBe('propose');
		expect(r.gate?.reason).toContain('low_trust');
		// Phase-2 fallback still applies the merge.
		expect(['applied', 'partial', 'noop']).toContain(r.status);
	});

	it('fatal audit ⇒ gate.reject, observation recorded rejected (no source mutated)', async () => {
		const r = await mergeSourceObservation(db, {
			origin: 'website',
			originRecordId: 'website:bad',
			derivation: 'editorial_decision',
			confidence: 2, // out of range → fatal
			fields: { title: 'Bad', type: 'article', category: 'secondary' }
		});
		expect(r.gate?.mode).toBe('reject');
		expect(r.status).toBe('rejected');
		expect((await db.select().from(schema.sources)).length).toBe(0);
	});
});

describe('planSourceObservation + commitMerge compose', () => {
	it('plan then commit is equivalent to the public entry', async () => {
		const input = observed({ originRecordId: 'crossref:compose-1' });
		const plan = await planSourceObservation(db, input);
		expect(plan.gate.mode).toBe('propose'); // brand new
		const r = await commitMerge(db, plan);
		expect(r.status).toBe('applied');
		expect(r.sourceId).toBeTruthy();
	});

	it('opt-in simulate produces a read-only proposal preview without writing', async () => {
		// seed a source, then simulate a NON-applied enrichment against it.
		const created = await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:sim-base', identifiers: [{ kind: 'doi', value: '10.9012/z' }] })
		);
		const sid = created.sourceId!;
		const before = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		const plan = await planSourceObservation(
			db,
			{
				origin: 'openalex',
				originRecordId: 'openalex:sim-1',
				derivation: 'llm_extraction',
				confidence: 0.9,
				evidence: 2,
				identifiers: [{ kind: 'doi', value: '10.9012/z' }],
				fields: { title: 'A Work', type: 'article', category: 'secondary', summary: 'previewed' }
			},
			{ simulate: true }
		);
		// the preview is populated…
		expect(plan.diff).not.toBeNull();
		expect(plan.beforeProjection).not.toBeNull();
		expect(plan.predictedFieldOutcomes.length).toBeGreaterThan(0);
		const summaryOutcome = plan.predictedFieldOutcomes.find((o) => o.field === 'summary');
		expect(summaryOutcome?.status).toBe('will_apply');
		// …and NOTHING was written (pure reads).
		const after = await db.select().from(schema.sources).where(eq(schema.sources.id, sid));
		expect(after[0].contentHash).toBe(before[0].contentHash);
		expect(after[0].summary).toBe(before[0].summary);
	});
});
