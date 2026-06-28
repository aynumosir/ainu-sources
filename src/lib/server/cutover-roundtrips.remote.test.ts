/**
 * Round-trip BUDGET regression on REAL remote Turso (staging).
 *
 * The cutover 500 was not a SQL/FK error — it was an OPERATIONAL one: every
 * editorial edit fanned out a long sequence of single-statement autocommit
 * round-trips, and on the Cloudflare Worker each statement is its own HTTP
 * subrequest (the Worker caps a request at ~50 subrequests). PR #35 measured an
 * editorial UPDATE at ~40 round-trips and a new-source CREATE at ~72 — both
 * uncomfortably close to (or over) the budget.
 *
 * This suite runs the ACTUAL website write paths (`updateSourceViaMerge` /
 * `createSourceViaMerge`) against a real stateless `@libsql/client/web`
 * connection — the same client the Worker uses — through a COUNTING proxy that
 * tallies every `client.execute` (one round-trip) and `client.batch` (also one
 * round-trip, regardless of how many statements it carries). It asserts that
 * BOTH paths now complete well under the subrequest budget.
 *
 * Gated on TEST_TURSO_DATABASE_URL (skipped offline so `bun run test` stays
 * fast). It WRITES to the target DB — point it ONLY at a disposable staging DB.
 *
 *   TEST_TURSO_DATABASE_URL=libsql://…  TEST_TURSO_AUTH_TOKEN=… \
 *     bunx vitest run src/lib/server/cutover-roundtrips.remote.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient, type Client } from '@libsql/client/web';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from './db/schema';
import { createSourceViaMerge, updateSourceViaMerge } from './merge-write';
import type { SourceInput, EditUser } from './queries';

const URL = process.env.TEST_TURSO_DATABASE_URL;
const TOKEN = process.env.TEST_TURSO_AUTH_TOKEN;
const RUN = !!URL;
/** Subrequest budget headroom: assert both paths stay well under the Worker cap. */
const BUDGET = 20;

type Db = LibSQLDatabase<typeof schema>;
const USER: EditUser = { id: 'cutover-rt-test', name: 'Cutover Round-Trip Test' };

interface Counter {
	execute: number;
	batch: number;
	batchStatements: number;
}

/** Wrap a libSQL client so every network call is counted. `execute` and `batch`
 *  are each exactly ONE HTTP round-trip (one Worker subrequest); a batch carries
 *  many statements but still costs one round-trip. */
const DEBUG = !!process.env.DEBUG_RT;
const sqlOf = (s: unknown) => String((s as { sql?: string })?.sql ?? s).replace(/\s+/g, ' ').slice(0, 70);
function countingClient(real: Client): { client: Client; counter: Counter } {
	const counter: Counter = { execute: 0, batch: 0, batchStatements: 0 };
	const client = new Proxy(real, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (prop === 'execute' && typeof value === 'function') {
				return (...args: unknown[]) => {
					counter.execute++;
					if (DEBUG) process.stderr.write(`  RT#${counter.execute + counter.batch} exec  ${sqlOf(args[0])}\n`);
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			if (prop === 'batch' && typeof value === 'function') {
				return (...args: unknown[]) => {
					counter.batch++;
					const first = args[0];
					counter.batchStatements += Array.isArray(first) ? first.length : 0;
					if (DEBUG) process.stderr.write(`  RT#${counter.execute + counter.batch} batch(${Array.isArray(first) ? first.length : 0}) ${Array.isArray(first) ? sqlOf(first[0]) : ''}\n`);
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			}
			if (typeof value === 'function') return value.bind(target);
			return value;
		}
	}) as Client;
	return { client, counter };
}

const roundTrips = (c: Counter) => c.execute + c.batch;

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

describe.runIf(RUN)('cutover round-trip budget on remote Turso (staging)', () => {
	let realClient: Client;
	let baseDb: Db;
	beforeAll(() => {
		realClient = createClient({ url: URL!, authToken: TOKEN });
		baseDb = drizzle(realClient, { schema }) as Db;
	});

	it('editorial UPDATE completes under the subrequest budget', async () => {
		// Seed a DEDICATED source first (uncounted) so the measurement is isolated
		// from the sibling remote suite (which edits "the first active source"); the
		// projection assertion below is then deterministic under parallel execution.
		const seedMarker = `cutover-rt UPDATE seed ${new Date().toISOString()} ${crypto.randomUUID()}`;
		const seed = await createSourceViaMerge(
			baseDb,
			{
				title: seedMarker,
				titleEn: seedMarker,
				titleAin: null,
				category: 'primary',
				type: 'book',
				author: 'Seed Author',
				yearText: '2026',
				yearStart: 2026,
				yearEnd: null,
				yearCertainty: 'exact',
				dialect: null,
				region: 'hokkaido',
				languages: ['ain', 'jpn'],
				scripts: ['Latn'],
				holdingInstitution: null,
				callNumber: null,
				entryCount: null,
				entryCountLabel: null,
				license: null,
				summary: 'seed summary',
				notes: 'seed notes',
				reliability: null,
				links: [],
				tagNames: []
			},
			USER,
			'seed'
		);
		const sid = seed.result.sourceId!;
		expect(sid).toBeTruthy();
		const [src] = await baseDb.select().from(schema.sources).where(eq(schema.sources.id, sid)).limit(1);

		const marker = `cutover-rt UPDATE ${new Date().toISOString()} ${crypto.randomUUID()}`;
		const input = inputFrom(src, { summary: marker });

		const { client, counter } = countingClient(realClient);
		const db = drizzle(client, { schema }) as Db;
		const out = await updateSourceViaMerge(db, sid, input, USER, 'round-trip budget');

		// eslint-disable-next-line no-console
		console.log(
			`[round-trips] UPDATE status=${out.result.status} total=${roundTrips(counter)} ` +
				`(execute=${counter.execute} batch=${counter.batch}/${counter.batchStatements} stmts)`
		);
		expect(out.result.status).toBe('applied');
		const [after] = await baseDb
			.select({ summary: schema.sources.summary })
			.from(schema.sources)
			.where(eq(schema.sources.id, sid))
			.limit(1);
		expect(after.summary).toBe(marker);

		const fk = await realClient.execute('PRAGMA foreign_key_check');
		expect(fk.rows.length).toBe(0);
		expect(roundTrips(counter)).toBeLessThan(BUDGET);
	}, 180_000);

	it('new-source CREATE completes under the subrequest budget', async () => {
		const marker = `cutover-rt CREATE ${new Date().toISOString()} ${crypto.randomUUID()}`;
		const input: SourceInput = {
			title: marker,
			titleEn: marker, // unique → the slug is unique on the first check (no collision loop)
			titleAin: null,
			category: 'primary',
			type: 'book',
			author: 'Round Trip Tester',
			yearText: '2026',
			yearStart: 2026,
			yearEnd: null,
			yearCertainty: 'exact',
			dialect: 'Hokkaido',
			region: 'hokkaido',
			languages: ['ain', 'jpn'],
			scripts: ['Latn', 'Kana'],
			holdingInstitution: 'Test Institution',
			callNumber: 'RT-001',
			entryCount: 42,
			entryCountLabel: 'entries',
			license: 'CC-BY-4.0',
			summary: 'A disposable source created to measure the create-path round-trip count.',
			notes: 'created by cutover-roundtrips.remote.test.ts',
			reliability: 'medium',
			links: [{ type: 'website', url: `https://example.com/${crypto.randomUUID()}`, label: 'home' }],
			tagNames: ['round-trip-test']
		};

		const { client, counter } = countingClient(realClient);
		const db = drizzle(client, { schema }) as Db;
		const out = await createSourceViaMerge(db, input, USER, 'round-trip budget create');

		// eslint-disable-next-line no-console
		console.log(
			`[round-trips] CREATE status=${out.result.status} total=${roundTrips(counter)} ` +
				`(execute=${counter.execute} batch=${counter.batch}/${counter.batchStatements} stmts)`
		);
		// A fresh title with a unique handle takes the create path → applied.
		expect(out.result.status).toBe('applied');
		expect(out.result.sourceId).toBeTruthy();

		// projection is correct: the flat `sources` row reflects the submitted fields.
		const [created] = await baseDb
			.select()
			.from(schema.sources)
			.where(eq(schema.sources.id, out.result.sourceId!))
			.limit(1);
		expect(created.title).toBe(marker);
		expect(created.type).toBe('book');
		expect(created.author).toBe('Round Trip Tester');
		expect(created.summary).toBe(input.summary);
		expect(new Set(created.languages as string[])).toEqual(new Set(['ain', 'jpn']));
		expect(new Set(created.scripts as string[])).toEqual(new Set(['Latn', 'Kana']));

		const fk = await realClient.execute('PRAGMA foreign_key_check');
		expect(fk.rows.length).toBe(0);
		expect(roundTrips(counter)).toBeLessThan(BUDGET);
	}, 180_000);
});
