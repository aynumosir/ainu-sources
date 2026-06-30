/**
 * Stuck-`applying` recovery (Git-in-the-DB Phase 4 sweeper).
 *
 * The apply lock flips a CR to `applying` as a single atomic statement, then
 * re-plans → commits → finalizes. On a stateless Worker a crash / timeout / spend
 * cutoff BETWEEN the lock and the finalize can pin a CR at `applying` forever — the
 * lock's `WHERE status IN (open,needs_evidence,approved)` then refuses every retry.
 *
 * `recoverStuckApplyingChangeRequests` resets CRs older than a threshold back to a
 * reviewable `needs_evidence` so a human / retry can drive them again. It is SAFE
 * TO RE-RUN — applyChangeRequest is idempotent — and writes NO canonical data
 * itself. These tests prove it reopens an OLD stuck CR and leaves a FRESH one alone.
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
	recoverStuckApplyingChangeRequests
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

const observed = (over: Partial<MergeInput>): MergeInput => ({
	origin: 'crossref',
	originRecordId: 'crossref:base',
	derivation: 'observed',
	confidence: 0.9,
	fields: { title: 'A Work', type: 'article', category: 'secondary' },
	...over
});

async function propose(originRecordId: string): Promise<ProposedMergeResult> {
	env.SOURCES_ENABLE_PROPOSE = 'true';
	const r = (await mergeSourceObservation(db, observed({ originRecordId }))) as ProposedMergeResult;
	expect(r.status).toBe('proposed');
	return r;
}

const crRow = async (id: string) =>
	(await db.select().from(schema.changeRequests).where(eq(schema.changeRequests.id, id)))[0];

const THRESHOLD = 15 * 60 * 1000;

describe('recoverStuckApplyingChangeRequests', () => {
	it('resets a CR stuck in "applying" beyond the threshold back to needs_evidence', async () => {
		const cr = await propose('crossref:stuck');
		// pin it 'applying' with an OLD updatedAt (1h ago)
		await db
			.update(schema.changeRequests)
			.set({ status: 'applying', updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
			.where(eq(schema.changeRequests.id, cr.changeRequestId));

		const { recovered } = await recoverStuckApplyingChangeRequests(db, { olderThanMs: THRESHOLD });
		expect(recovered).toContain(cr.changeRequestId);
		expect((await crRow(cr.changeRequestId)).status).toBe('needs_evidence');

		// and it can be driven to completion again (the helper re-opened the lock)
		const res = await applyChangeRequest(db, cr.changeRequestId, 'mod-1');
		expect(res.status).toBe('applied');
		expect((await crRow(cr.changeRequestId)).status).toBe('applied');
	});

	it('leaves a FRESH applying CR alone (within the threshold)', async () => {
		const cr = await propose('crossref:fresh');
		await db
			.update(schema.changeRequests)
			.set({ status: 'applying', updatedAt: new Date() })
			.where(eq(schema.changeRequests.id, cr.changeRequestId));

		const { recovered } = await recoverStuckApplyingChangeRequests(db, { olderThanMs: THRESHOLD });
		expect(recovered).toEqual([]);
		expect((await crRow(cr.changeRequestId)).status).toBe('applying'); // untouched
	});

	it('is a noop when nothing is stuck', async () => {
		await propose('crossref:none'); // an OPEN CR, not applying
		const { recovered } = await recoverStuckApplyingChangeRequests(db);
		expect(recovered).toEqual([]);
	});
});
