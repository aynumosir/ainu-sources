/**
 * Git-in-the-DB Phase 4 FULL CYCLE on REAL remote Turso (staging).
 *
 * Drives a brand-new source through the entire propose → review → apply pipeline
 * against the same stateless web libSQL client the Cloudflare Worker uses, on a
 * FK-enforcing remote DB (which the file/:memory: libSQL suite cannot exercise):
 *
 *   1. with SOURCES_ENABLE_PROPOSE on, a new-source observation routes to a change
 *      request — ZERO canonical write (no `sources` row yet);
 *   2. reviewChangeRequest(human, apply) → applyChangeRequest re-plans LIVE and
 *      commits through the SAME engine: the source NOW exists in canonical
 *      (sources + claims + provenance), the CR flips to `applied`, the observation
 *      `proposed`→`applied`, and an `applied` diff is written alongside the
 *      `proposal` one;
 *   3. re-applying is a NOOP (the lock returns the recorded result — no new rows);
 *   4. `PRAGMA foreign_key_check` is clean on the FK-enforcing remote DB.
 *
 * Gated on TEST_TURSO_DATABASE_URL so the default `bun run test` stays fast and
 * offline. It WRITES namespaced probe rows and CLEANS THEM UP afterward — point it
 * ONLY at a disposable staging database, NEVER production:
 *
 *   TEST_TURSO_DATABASE_URL=libsql://…  TEST_TURSO_AUTH_TOKEN=… \
 *     bunx vitest run src/lib/server/apply.remote.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient, type Client } from '@libsql/client/web';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from './db/schema';
import {
	mergeSourceObservation,
	reviewChangeRequest,
	applyChangeRequest,
	type MergeInput,
	type ProposedMergeResult
} from './merge';

const URL = process.env.TEST_TURSO_DATABASE_URL;
const TOKEN = process.env.TEST_TURSO_AUTH_TOKEN;
const RUN = !!URL;
type Db = LibSQLDatabase<typeof schema>;

describe.runIf(RUN)('Phase 4 full cycle on remote Turso (staging): propose → review → apply', () => {
	let client: Client;
	let db: Db;
	const stamp = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
	const origin = 'phase4-remote-test';
	const originRecordId = `phase4:new:${stamp}`;
	let observationId = '';
	let changeRequestId = '';
	let sourceId = '';

	beforeAll(() => {
		client = createClient({ url: URL!, authToken: TOKEN });
		db = drizzle(client, { schema }) as Db;
		env.SOURCES_ENABLE_PROPOSE = 'true';
	});

	afterAll(async () => {
		// FK-safe teardown of the probe rows (children → parents). Test files are
		// excluded from the no-destructive-write CI guard; this only removes the rows
		// THIS test created and never touches existing catalogue data.
		try {
			if (changeRequestId) {
				await db
					.delete(schema.changeRequestReviews)
					.where(eq(schema.changeRequestReviews.changeRequestId, changeRequestId));
				await db.delete(schema.changeRequests).where(eq(schema.changeRequests.id, changeRequestId));
			}
			if (observationId)
				await db
					.delete(schema.sourceObservationDiffs)
					.where(eq(schema.sourceObservationDiffs.observationId, observationId));
			if (sourceId) {
				await db
					.delete(schema.sourceFieldProvenance)
					.where(eq(schema.sourceFieldProvenance.sourceId, sourceId));
				await db
					.delete(schema.sourceFieldClaims)
					.where(eq(schema.sourceFieldClaims.sourceId, sourceId));
				await db
					.delete(schema.sourceLifecycleEvents)
					.where(eq(schema.sourceLifecycleEvents.sourceId, sourceId));
				await db
					.delete(schema.sourceRevisions)
					.where(eq(schema.sourceRevisions.sourceId, sourceId));
				await db.delete(schema.sources).where(eq(schema.sources.id, sourceId));
			}
			if (observationId)
				await db
					.delete(schema.sourceObservations)
					.where(eq(schema.sourceObservations.id, observationId));
			await db
				.delete(schema.sourceObservedRecords)
				.where(eq(schema.sourceObservedRecords.origin, origin));
		} finally {
			delete env.SOURCES_ENABLE_PROPOSE;
		}
	});

	it('propose (no canonical) → apply (canonical written) → idempotent re-apply; FK clean', async () => {
		const input: MergeInput = {
			origin,
			originRecordId,
			derivation: 'observed',
			confidence: 0.9,
			fields: { title: `Phase4 Remote ${stamp}`, type: 'article', category: 'secondary' }
		};

		// 1. PROPOSE — a brand-new source routes to a CR; ZERO canonical write.
		const proposed = (await mergeSourceObservation(db, input)) as ProposedMergeResult;
		expect(proposed.status).toBe('proposed');
		observationId = proposed.observationId;
		changeRequestId = proposed.changeRequestId;
		expect(proposed.sourceId).toBeUndefined();
		const [preObs] = await db
			.select()
			.from(schema.sourceObservations)
			.where(eq(schema.sourceObservations.id, observationId));
		expect(preObs.status).toBe('proposed');
		const [openCr] = await db
			.select()
			.from(schema.changeRequests)
			.where(eq(schema.changeRequests.id, changeRequestId));
		expect(openCr.status).toBe('open');
		expect(openCr.sourceId).toBeNull(); // new source — nothing canonical yet

		// 2. REVIEW + APPLY (human apply) — re-plans live and commits via the engine.
		const review = await reviewChangeRequest(db, changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'phase4-remote',
			verdict: 'apply',
			reason: 'staging full cycle'
		});
		expect(review.status).toBe('applied');
		sourceId = review.applied!.sourceId!;
		expect(sourceId).toBeTruthy();

		// 3. canonical NOW exists: source + claims + provenance written.
		const [src] = await db.select().from(schema.sources).where(eq(schema.sources.id, sourceId));
		expect(src.title).toBe(`Phase4 Remote ${stamp}`);
		const claims = await db
			.select()
			.from(schema.sourceFieldClaims)
			.where(eq(schema.sourceFieldClaims.sourceId, sourceId));
		expect(claims.length).toBeGreaterThan(0);
		const prov = await db
			.select()
			.from(schema.sourceFieldProvenance)
			.where(eq(schema.sourceFieldProvenance.sourceId, sourceId));
		expect(prov.length).toBeGreaterThan(0);

		// CR finalized, observation flipped proposed → applied.
		const [cr] = await db
			.select()
			.from(schema.changeRequests)
			.where(eq(schema.changeRequests.id, changeRequestId));
		expect(cr.status).toBe('applied');
		expect(cr.sourceId).toBe(sourceId);
		expect(cr.appliedObservationStatus).toBe('applied');
		const [obs] = await db
			.select()
			.from(schema.sourceObservations)
			.where(eq(schema.sourceObservations.id, observationId));
		expect(obs.status).toBe('applied');

		// an 'applied' diff was added alongside the 'proposal' one.
		const diffs = await db
			.select()
			.from(schema.sourceObservationDiffs)
			.where(eq(schema.sourceObservationDiffs.observationId, observationId));
		expect(diffs.map((d) => d.diffKind).sort()).toEqual(['applied', 'proposal']);

		// 4. RE-APPLY is a NOOP — convergent, no new rows.
		const re = await applyChangeRequest(db, changeRequestId, 'phase4-remote-2');
		expect(re.sourceId).toBe(sourceId);
		const claimsAfter = await db
			.select()
			.from(schema.sourceFieldClaims)
			.where(eq(schema.sourceFieldClaims.sourceId, sourceId));
		expect(claimsAfter.length).toBe(claims.length);
		const diffsAfter = await db
			.select()
			.from(schema.sourceObservationDiffs)
			.where(eq(schema.sourceObservationDiffs.observationId, observationId));
		expect(diffsAfter.length).toBe(diffs.length);

		// 5. FK integrity holds on the FK-enforcing remote DB.
		const fk = await client.execute('PRAGMA foreign_key_check');
		expect(fk.rows.length).toBe(0);
	}, 180_000);
});
