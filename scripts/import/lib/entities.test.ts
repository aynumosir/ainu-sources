/**
 * Idempotency of the DB-backed entity resolvers + join upserts.
 *
 * Runs against a REAL isolated libSQL :memory: database built from the drizzle
 * migrations (same setup as the merge-engine tests), so the join tables' deferred
 * UNIQUE semantics and the existence-checked upserts are exercised for real.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { eq } from 'drizzle-orm';
import * as schema from '../../../src/lib/server/db/schema';
import { addPersons, addPlaces, attachTags, getPerson, type EntityStamp } from './entities';
import { TAG_DEFS } from './derive';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));
type Db = LibSQLDatabase<typeof schema>;

const STAMP: EntityStamp = { origin: 'ainu-dictionaries', confidence: 0.8 };

async function makeDb(): Promise<Db> {
	const client = createClient({ url: ':memory:' });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: MIGRATIONS });
	return db;
}

async function newSource(db: Db, over: Partial<typeof schema.sources.$inferInsert> = {}): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(schema.sources).values({
		id,
		slug: `s-${id.slice(0, 8)}`,
		title: 'テスト辞典',
		category: 'primary',
		type: 'dictionary',
		provenanceRepo: 'ainu-dictionaries',
		...over
	});
	return id;
}

let db: Db;
beforeEach(async () => {
	db = await makeDb();
});

describe('addPersons idempotency', () => {
	it('double addPersons(same author) yields exactly one person + one join row', async () => {
		const sid = await newSource(db);
		await addPersons(db, sid, 'Nakagawa, Hiroshi', STAMP);
		await addPersons(db, sid, 'Nakagawa, Hiroshi', STAMP);

		const joins = await db.select().from(schema.sourcePersons).where(eq(schema.sourcePersons.sourceId, sid));
		expect(joins).toHaveLength(1);
		expect(joins[0].role).toBe('author');
		expect(joins[0].sortOrder).toBe(0);

		const people = await db.select().from(schema.persons);
		expect(people).toHaveLength(1);
		// resolves to the canonical slug seed.ts uses
		expect(people[0].slug).toBe('nakagawa-hiroshi');
	});

	it('preserves author sortOrder across re-runs (co-authors)', async () => {
		const sid = await newSource(db);
		const author = 'Uehara, Kumajiro (上原熊次郎); Abe, Chozaburo (阿部長三郎)';
		await addPersons(db, sid, author, STAMP);
		await addPersons(db, sid, author, STAMP); // idempotent re-run

		const joins = await db
			.select({ slug: schema.persons.slug, sortOrder: schema.sourcePersons.sortOrder })
			.from(schema.sourcePersons)
			.innerJoin(schema.persons, eq(schema.sourcePersons.personId, schema.persons.id))
			.where(eq(schema.sourcePersons.sourceId, sid));
		expect(joins).toHaveLength(2);
		const bySlug = Object.fromEntries(joins.map((j) => [j.slug, j.sortOrder]));
		expect(bySlug['uehara-kumajiro']).toBe(0);
		expect(bySlug['abe-chozaburo']).toBe(1);
	});

	it('two different sources sharing an author reuse the one person row', async () => {
		const a = await newSource(db);
		const b = await newSource(db);
		await addPersons(db, a, 'Batchelor, John', STAMP);
		await addPersons(db, b, 'Batchelor, John', STAMP);
		expect(await db.select().from(schema.persons)).toHaveLength(1);
		expect(await db.select().from(schema.sourcePersons)).toHaveLength(2);
	});

	it('drops anonymous / institution author tokens', async () => {
		const sid = await newSource(db);
		await addPersons(db, sid, 'unknown', STAMP);
		await addPersons(db, sid, '北海道ウタリ協会', STAMP); // institution → not a person
		expect(await db.select().from(schema.sourcePersons)).toHaveLength(0);
	});
});

describe('addPlaces / attachTags idempotency', () => {
	it('double addPlaces yields one join per place', async () => {
		const sid = await newSource(db);
		await addPlaces(db, sid, '沙流', STAMP);
		await addPlaces(db, sid, '沙流', STAMP);
		const joins = await db.select().from(schema.sourcePlaces).where(eq(schema.sourcePlaces.sourceId, sid));
		expect(joins).toHaveLength(1);
		expect(joins[0].role).toBe('dialect');
	});

	it('double attachTags yields one join per matched tag', async () => {
		const sid = await newSource(db);
		const texts = ['アイヌ語辞典', 'Ainu dictionary', 'dictionary', ''];
		await attachTags(db, sid, texts, STAMP, TAG_DEFS);
		const first = await db.select().from(schema.sourceTags).where(eq(schema.sourceTags.sourceId, sid));
		await attachTags(db, sid, texts, STAMP, TAG_DEFS);
		const second = await db.select().from(schema.sourceTags).where(eq(schema.sourceTags.sourceId, sid));
		expect(second.length).toBe(first.length);
		expect(first.length).toBeGreaterThan(0); // 'lexicon' at least
	});
});

describe('getPerson slug resolution matches seed.ts', () => {
	it('resolves aliased forms to the same canonical person', async () => {
		const p1 = await getPerson(db, '中川裕', STAMP);
		const p2 = await getPerson(db, 'Nakagawa, Hiroshi', STAMP);
		expect(p1).toBe(p2); // both fold to canon 'nakagawa-hiroshi'
		expect(await db.select().from(schema.persons)).toHaveLength(1);
	});
});
