import { expect, it, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './db/schema';

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock('./db', () => ({ get db() { return state.db; } }));
import { getPersonBySlug, getSourceDetail, listPersonRoles, listPersons } from './queries';

it('groups recorders with authors across filters and details without duplicate works or roles', async () => {
	const client = createClient({ url: 'file::memory:' });
	try {
		const db = drizzle(client, { schema });
		state.db = db;
		await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../../drizzle', import.meta.url)) });
		await db.insert(schema.persons).values([
			{ id: 'writer', slug: 'writer', name: 'Writer' },
			{ id: 'recorder', slug: 'recorder', name: 'Recorder' }
		]);
		await db.insert(schema.sources).values({ id: 'book', slug: 'book', title: 'Book', type: 'book' });
		await db.insert(schema.sourcePersons).values([
			{ id: 'a', sourceId: 'book', personId: 'writer', role: 'author' },
			{ id: 'r', sourceId: 'book', personId: 'writer', role: 'recorder' },
			{ id: 's', sourceId: 'book', personId: 'writer', role: 'speaker' },
			{ id: 'r2', sourceId: 'book', personId: 'recorder', role: 'recorder' }
		]);
		expect(await listPersonRoles()).toEqual(['author', 'speaker']);
		for (const role of ['author', 'recorder']) {
			const people = await listPersons({ role });
			expect(people.map(p => p.id).sort()).toEqual(['recorder', 'writer']);
			expect(people.every(p => p.sourceCount === 1)).toBe(true);
			expect(people.every(p => p.roles.includes('author') && !p.roles.includes('recorder'))).toBe(true);
		}
		const person = await getPersonBySlug('writer');
		expect(person?.sources.map(s => s.role).sort()).toEqual(['author', 'speaker']);
		const source = await getSourceDetail('book');
		expect(source?.persons.map(p => p.id + ':' + p.role).sort()).toEqual(['recorder:author', 'writer:author', 'writer:speaker']);
	} finally { client.close(); }
});
