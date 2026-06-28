/**
 * Cutover regression test on REAL remote Turso (staging).
 *
 * The website create/update "cutover" routes every editorial edit through the
 * merge engine (`mergeSourceObservation`). It passed the in-memory/file libSQL
 * suite but 500'd the first time it hit production: the request fanned out a long
 * sequence of single-statement autocommit round-trips to remote Turso and the
 * failure surfaced at the engine's finalize step —
 *   `UPDATE source_observations SET status, match_decision WHERE id`
 * — which the file-libSQL tests never exercised against a real remote connection.
 *
 * This suite runs the ACTUAL website update path (`updateSourceViaMerge`) against
 * a real remote libSQL HTTP connection (the same stateless web client the
 * Cloudflare Worker uses) and asserts the incident regression directly: the
 * editorial edit auto-applies, the finalize UPDATE succeeds, the projection
 * changes, a revision is recorded, the edit is idempotent, and FK integrity holds.
 *
 * Gated on TEST_TURSO_DATABASE_URL so the default `bun run test` stays fast and
 * offline — this only runs when pointed at a disposable staging DB:
 *
 *   TEST_TURSO_DATABASE_URL=libsql://…  TEST_TURSO_AUTH_TOKEN=… \
 *     bunx vitest run src/lib/server/cutover.remote.test.ts
 *
 * It WRITES to the target DB (a new `summary` value + ledger rows on one existing
 * source). Point it ONLY at a disposable staging database, never production.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type Client } from '@libsql/client/web';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { and, eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { hashValue } from './merge';
import { updateSourceViaMerge } from './merge-write';
import type { SourceInput, EditUser } from './queries';

const URL = process.env.TEST_TURSO_DATABASE_URL;
const TOKEN = process.env.TEST_TURSO_AUTH_TOKEN;
const RUN = !!URL;

type Db = LibSQLDatabase<typeof schema>;
const USER: EditUser = { id: 'cutover-remote-test', name: 'Cutover Remote Test' };

/** Build a full SourceInput from the current row (only `over` fields differ). */
function inputFrom(src: typeof schema.sources.$inferSelect, over: Partial<SourceInput>): SourceInput {
	return {
		title: src.title,
		titleEn: src.titleEn ?? null,
		titleAin: src.titleAin ?? null,
		category: src.category,
		type: src.type,
		author: src.author ?? null,
		yearText: src.yearText ?? null,
		yearStart: src.yearStart ?? null,
		yearEnd: src.yearEnd ?? null,
		yearCertainty: src.yearCertainty ?? 'exact',
		dialect: src.dialect ?? null,
		region: src.region ?? null,
		languages: (src.languages as string[] | null) ?? [],
		scripts: (src.scripts as string[] | null) ?? [],
		holdingInstitution: src.holdingInstitution ?? null,
		callNumber: src.callNumber ?? null,
		entryCount: src.entryCount ?? null,
		entryCountLabel: src.entryCountLabel ?? null,
		license: src.license ?? null,
		summary: src.summary ?? null,
		notes: src.notes ?? null,
		reliability: src.reliability ?? null,
		links: [],
		tagNames: [],
		...over
	};
}

describe.runIf(RUN)('cutover write path on remote Turso (staging)', () => {
	let client: Client;
	let db: Db;
	// Construct the remote client in beforeAll, NOT at collection time, so the
	// suite is cleanly skipped (no `URL_INVALID`) when the env var is unset.
	beforeAll(() => {
		client = createClient({ url: URL!, authToken: TOKEN });
		db = drizzle(client, { schema }) as Db;
	});

	it('editorial update auto-applies through the engine on remote (incident regression)', async () => {
		const [src] = await db
			.select()
			.from(schema.sources)
			.where(eq(schema.sources.status, 'active'))
			.limit(1);
		expect(src, 'staging must have at least one active source').toBeTruthy();

		// Use `summary` — a scalar (ranked-replace) field, so an editorial edit WINS
		// and the projection becomes exactly the marker (deterministic to assert),
		// unlike `notes` which is append-or-ranked and would concatenate.
		const marker = `cutover-remote-test ${new Date().toISOString()} ${crypto.randomUUID()}`;
		const markerHash = hashValue(marker);
		const input = inputFrom(src, { summary: marker });

		const revsBefore = await db
			.select({ id: schema.sourceRevisions.id })
			.from(schema.sourceRevisions)
			.where(eq(schema.sourceRevisions.sourceId, src.id));

		// (1) the edit auto-applies — and the finalize UPDATE source_observations
		//     succeeds (the run would otherwise throw exactly as it did on prod).
		const out = await updateSourceViaMerge(db, src.id, input, USER, 'staging regression');
		expect(out.result.status).toBe('applied');
		expect(out.result.sourceId).toBe(src.id); // deterministic attach — never forked

		// (1b) the incident's exact statement landed: status + match_decision were
		//      written onto the observation row on the remote DB.
		const [obs] = await db
			.select()
			.from(schema.sourceObservations)
			.where(eq(schema.sourceObservations.id, out.result.observationId!))
			.limit(1);
		expect(obs, 'the observation row exists on remote').toBeTruthy();
		expect(obs.status).toBe('applied');
		expect(obs.matchDecision).toBe('explicit_target');

		// (2) the projected `sources` field actually changed.
		const [after] = await db
			.select({ summary: schema.sources.summary })
			.from(schema.sources)
			.where(eq(schema.sources.id, src.id))
			.limit(1);
		expect(after.summary).toBe(marker);

		// (3) a source_revision row was written for this edit.
		const revsAfter = await db
			.select({ id: schema.sourceRevisions.id })
			.from(schema.sourceRevisions)
			.where(eq(schema.sourceRevisions.sourceId, src.id));
		expect(revsAfter.length).toBeGreaterThan(revsBefore.length);

		// (4) idempotent: re-running the identical edit is a no-op at the ledger —
		//     the engine dedupes the observation, the source never forks, and the
		//     editorial summary claim exists exactly once (no duplicate rows).
		const out2 = await updateSourceViaMerge(db, src.id, input, USER, 'staging regression (rerun)');
		expect(out2.result.status).toBe('noop');
		const sameId = await db
			.select({ id: schema.sources.id })
			.from(schema.sources)
			.where(eq(schema.sources.id, src.id));
		expect(sameId.length).toBe(1);
		const summaryClaims = await db
			.select({ id: schema.sourceFieldClaims.id })
			.from(schema.sourceFieldClaims)
			.where(
				and(
					eq(schema.sourceFieldClaims.sourceId, src.id),
					eq(schema.sourceFieldClaims.fieldName, 'summary'),
					eq(schema.sourceFieldClaims.valueHash, markerHash)
				)
			);
		expect(summaryClaims.length).toBe(1);
		const [stillAfter] = await db
			.select({ summary: schema.sources.summary })
			.from(schema.sources)
			.where(eq(schema.sources.id, src.id))
			.limit(1);
		expect(stillAfter.summary).toBe(marker);

		// (5) FK integrity holds on the real (FK-enforcing) remote DB.
		const fk = await client.execute('PRAGMA foreign_key_check');
		expect(fk.rows.length).toBe(0);
	}, 180_000);
});
