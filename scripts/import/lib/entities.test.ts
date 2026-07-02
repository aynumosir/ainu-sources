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

describe('getPerson cross-form / cross-run identity folding (Risk A)', () => {
	it('folds a romaji form and the kanji form of one person onto ONE person id', async () => {
		// 'Hideo Kirikae' has NO canon alias (only 'Kirikae' / '切替英雄' do) → it would
		// get slug 'hideo-kirikae', while '切替英雄' resolves to canon 'kirikae-hideo'.
		// The romaji fold key (r:hideo kirikae) collapses them to one person.
		const p1 = await getPerson(db, 'Hideo Kirikae', STAMP);
		const p2 = await getPerson(db, '切替英雄', STAMP);
		expect(p2).toBe(p1);
		expect(await db.select().from(schema.persons)).toHaveLength(1);
	});

	it('resolves a name to an EXISTING DB person by romaji-fold WITHOUT creating one', async () => {
		// Simulate a bootstrapped canon person (as seed.ts wrote it).
		const bootId = crypto.randomUUID();
		await db.insert(schema.persons).values({
			id: bootId,
			slug: 'kirikae-hideo',
			name: '切替 英雄',
			nameEn: 'Kirikae Hideo',
			status: 'active'
		});
		// A differently-computed form (slug would be 'hideo-kirikae') must fold onto it.
		const resolved = await getPerson(db, 'Hideo Kirikae', STAMP);
		expect(resolved).toBe(bootId);
		const people = await db.select().from(schema.persons);
		expect(people).toHaveLength(1); // no duplicate minted
		expect(people[0].id).toBe(bootId);
		expect(people[0].slug).toBe('kirikae-hideo'); // slug/id untouched
	});

	it('backfills a bootstrapped romaji-display row to kanji + researchmap (non-projected, idempotent)', async () => {
		// A person first seen as bare romaji, with no researchmap.
		const bootId = crypto.randomUUID();
		await db.insert(schema.persons).values({
			id: bootId,
			slug: 'sakaguchi-ryo',
			name: 'Sakaguchi Ryo',
			nameEn: 'Sakaguchi Ryo',
			status: 'active'
		});
		// The kanji form (PERSON_ENRICH 阪口諒 → romaji 'Sakaguchi Ryo' + researchmap)
		// folds onto it via the romaji key and upgrades the display — never the slug/id.
		const r1 = await getPerson(db, '阪口諒', STAMP);
		expect(r1).toBe(bootId);
		let people = await db.select().from(schema.persons);
		expect(people).toHaveLength(1);
		expect(people[0].id).toBe(bootId);
		expect(people[0].slug).toBe('sakaguchi-ryo');
		expect(people[0].name).toBe('阪口 諒'); // romaji-display upgraded to kanji
		expect(people[0].researchmap).toBe('SAKAGUCHI_Ryo'); // backfilled
		// Second resolution of the same form is a pure noop.
		const r2 = await getPerson(db, '阪口諒', STAMP);
		expect(r2).toBe(bootId);
		people = await db.select().from(schema.persons);
		expect(people).toHaveLength(1);
	});

	it('idempotency: resolving the same name twice creates exactly one person', async () => {
		const a = await getPerson(db, '知里眞志保', STAMP); // 眞 variant of 真, PERSON_ENRICH-known
		const b = await getPerson(db, '知里眞志保', STAMP);
		expect(b).toBe(a);
		expect(await db.select().from(schema.persons)).toHaveLength(1);
	});

	it('an unrelated name creates a distinct person', async () => {
		const known = await getPerson(db, '中川裕', STAMP);
		const other = await getPerson(db, 'Jane Q. Fieldworker', STAMP);
		expect(other).not.toBe(known);
		expect(await db.select().from(schema.persons)).toHaveLength(2);
	});
});
