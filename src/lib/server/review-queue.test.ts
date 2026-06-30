/**
 * `/admin/review` read model + role gate (Git-in-the-DB Phase 5) — against a real
 * :memory: DB. Proves:
 *   • the moderator GATE predicate (`isModerator`) the route load enforces;
 *   • `getReviewQueue` returns ONLY open/needs_evidence/approved CRs, newest first,
 *     each joined to its `proposal` diff (a decided CR drops out of the queue);
 *   • `getChangeRequestDetail` carries the diff, the observation payload/evidence,
 *     the attached source's current provenance, and the append-only reviews.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { env } from '$env/dynamic/private';
import * as schema from './db/schema';
import { isModerator } from './authz';
import { mergeSourceObservation, reviewChangeRequest } from './merge';
import { getReviewQueue, getChangeRequestDetail } from './review-queue';
import type { MergeInput, ProposedMergeResult } from './merge';

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
	delete env.MODERATOR_USER_IDS;
	delete env.ADMIN_USER_IDS;
});

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

/** seed one applied source (flag OFF ⇒ auto-applies, materializing canonical data). */
async function seedSource(): Promise<string> {
	const r = await mergeSourceObservation(
		db,
		observed({ originRecordId: 'crossref:seed', identifiers: [{ kind: 'doi', value: '10.1234/seed' }] })
	);
	return r.sourceId!;
}

describe('moderator gate (the predicate the route load enforces)', () => {
	it('an editor (any signed-in user) cannot view the queue; a moderator can', () => {
		env.MODERATOR_USER_IDS = 'mod-1';
		expect(isModerator({ id: 'editor-1' })).toBe(false);
		expect(isModerator({ id: 'mod-1' })).toBe(true);
		expect(isModerator(null)).toBe(false);
	});
	it('an admin is a moderator superset', () => {
		env.ADMIN_USER_IDS = 'boss';
		expect(isModerator({ id: 'boss' })).toBe(true);
	});
});

describe('getReviewQueue', () => {
	it('returns open proposals newest-first, each joined to its proposal diff', async () => {
		const sid = await seedSource();
		env.SOURCES_ENABLE_PROPOSE = 'true';

		// enrichment attaching to the seeded source (low-trust ⇒ proposed)
		const enrich = (await mergeSourceObservation(db, llmEnrichment({}))) as ProposedMergeResult;
		// brand-new-source proposal
		const fresh = (await mergeSourceObservation(
			db,
			observed({ originRecordId: 'crossref:brand-new', fields: { title: 'Fresh Work', type: 'book', category: 'primary' } })
		)) as ProposedMergeResult;

		const queue = await getReviewQueue(db);
		expect(queue.length).toBe(2);
		// newest first: the new-source proposal was submitted last
		expect(queue[0].id).toBe(fresh.changeRequestId);
		expect(queue[1].id).toBe(enrich.changeRequestId);

		// the join is total — every queued CR carries its proposal diff object
		for (const item of queue) {
			expect(item.diff).toBeTypeOf('object');
			expect(item.diff.version).toBe(1);
		}
		// enrichment attaches to the seeded source; new-source has no source id
		expect(queue[1].sourceId).toBe(sid);
		expect(queue[0].sourceId).toBeNull();
		expect(queue[0].kind).toBe('new_source');
		expect(queue[1].kind).toBe('enrichment');
	});

	it('a decided (rejected) CR drops out of the queue', async () => {
		await seedSource();
		env.SOURCES_ENABLE_PROPOSE = 'true';
		const enrich = (await mergeSourceObservation(db, llmEnrichment({}))) as ProposedMergeResult;

		expect((await getReviewQueue(db)).length).toBe(1);
		await reviewChangeRequest(db, enrich.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'reject',
			reason: 'not corroborated'
		});
		expect((await getReviewQueue(db)).length).toBe(0);
	});
});

describe('getChangeRequestDetail', () => {
	it('carries the diff, observation payload, current provenance, and reviews', async () => {
		const sid = await seedSource();
		env.SOURCES_ENABLE_PROPOSE = 'true';
		const enrich = (await mergeSourceObservation(db, llmEnrichment({}))) as ProposedMergeResult;

		const detail = await getChangeRequestDetail(db, enrich.changeRequestId);
		expect(detail).not.toBeNull();
		expect(detail!.changeRequest.kind).toBe('enrichment');
		expect(detail!.changeRequest.sourceId).toBe(sid);
		expect(detail!.diff?.version).toBe(1);
		expect(detail!.observation?.payload).toBeTypeOf('object');
		expect(detail!.observation?.status).toBe('proposed');
		// the attached source has live provenance (title/type/category were applied on seed)
		expect(detail!.currentProvenance.length).toBeGreaterThan(0);
		expect(detail!.reviews.length).toBe(0);

		// a recorded verdict surfaces in the append-only review log
		await reviewChangeRequest(db, enrich.changeRequestId, {
			reviewerKind: 'human',
			reviewerActor: 'mod-1',
			verdict: 'needs_evidence',
			reason: 'cite a source'
		});
		const after = await getChangeRequestDetail(db, enrich.changeRequestId);
		expect(after!.reviews.length).toBe(1);
		expect(after!.reviews[0].verdict).toBe('needs_evidence');
		expect(after!.changeRequest.status).toBe('needs_evidence');
	});

	it('returns null for an unknown id', async () => {
		expect(await getChangeRequestDetail(db, 'nope')).toBeNull();
	});
});
