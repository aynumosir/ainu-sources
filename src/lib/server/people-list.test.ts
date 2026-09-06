import { expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./db', () => ({ get db() { return state.db; } }));
import { listPersons, countPersons, PERSON_PAGE_SIZE, PERSON_MAX_OFFSET } from './queries';
import { parsePeopleQuery, loadPeopleChunk } from './people-list';

async function seed(n: number) {
	const client = createClient({ url: 'file::memory:' });
	const db = drizzle(client, { schema });
	state.db = db;
	await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../drizzle', import.meta.url)) });
	const ids = Array.from({ length: n }, (_, i) => String(i).padStart(3, '0'));
	await db.insert(schema.persons).values(ids.map((id) => ({ id, slug: `p-${id}`, name: `Person ${id}` })));
	await db.insert(schema.persons).values({ id: 'gone', slug: 'gone', name: 'Merged', status: 'merged', mergedIntoPersonId: '000' });
	await db.insert(schema.sources).values({ id: 's', slug: 's', title: 'S', type: 'other' });
	await db.insert(schema.sourcePersons).values([
		{ id: 'l1', sourceId: 's', personId: ids[n - 1], role: 'author' },
		{ id: 'l2', sourceId: 's', personId: ids[n - 2], role: 'speaker' }
	]);
	return client;
}

it('returns consecutive chunks that cover every active person exactly once', async () => {
	const n = PERSON_PAGE_SIZE * 2 + 7;
	const client = await seed(n);
	try {
		expect(await countPersons()).toBe(n);
		const first = await loadPeopleChunk({ q: '', role: '', sort: 'name', offset: 0 });
		expect(first.items).toHaveLength(PERSON_PAGE_SIZE);
		expect(first).toMatchObject({ total: n, offset: 0, limit: PERSON_PAGE_SIZE, hasMore: true });
		const second = await loadPeopleChunk({ q: '', role: '', sort: 'name', offset: PERSON_PAGE_SIZE });
		const last = await loadPeopleChunk({ q: '', role: '', sort: 'name', offset: PERSON_PAGE_SIZE * 2 });
		expect(last.items).toHaveLength(7);
		expect(last.hasMore).toBe(false);
		const all = [...first.items, ...second.items, ...last.items].map((p) => p.id);
		expect(new Set(all).size).toBe(n);
		expect(all).toEqual([...all].sort());
		expect(all).not.toContain('gone');
	} finally { client.close(); }
});

it('keeps the count filter in step with the list under a role filter', async () => {
	const client = await seed(5);
	try {
		expect(await countPersons({ role: 'speaker' })).toBe(1);
		expect((await listPersons({ role: 'speaker', limit: 10 })).map((p) => p.id)).toEqual(['003']);
		const chunk = await loadPeopleChunk({ q: '', role: 'author', sort: 'count', offset: 0 });
		expect(chunk.items.map((p) => p.id)).toEqual(['004']);
		expect(chunk).toMatchObject({ total: 1, hasMore: false });
		expect((await loadPeopleChunk({ q: '', role: '', sort: 'count', offset: 0 })).items.slice(0, 2).map((p) => p.id)).toEqual(['003', '004']);
	} finally { client.close(); }
});

it('rejects offsets that are negative, fractional or past the cap', () => {
	expect(parsePeopleQuery(new URLSearchParams('offset=-1'))).toBeUndefined();
	expect(parsePeopleQuery(new URLSearchParams('offset=1.5'))).toBeUndefined();
	expect(parsePeopleQuery(new URLSearchParams(`offset=${PERSON_MAX_OFFSET + 1}`))).toBeUndefined();
	expect(parsePeopleQuery(new URLSearchParams('offset=abc'))).toBeUndefined();
	expect(parsePeopleQuery(new URLSearchParams('offset=120&sort=name&role=recorder&q=x'))).toEqual({
		q: 'x', role: 'author', sort: 'name', offset: 120
	});
	expect(parsePeopleQuery(new URLSearchParams('sort=bogus'))).toMatchObject({ sort: 'count', offset: 0 });
});
