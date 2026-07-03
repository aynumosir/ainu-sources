/**
 * resolveSlug() — the slug-rename 301 fallthrough, on an isolated libSQL
 * in-memory database built from the real drizzle migrations (same harness as
 * merge-write.test.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import * as schema from './db/schema';
import { resolveSlug } from './resolve-slug';

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

async function seedSource(slug: string, status = 'active'): Promise<string> {
	const [row] = await db
		.insert(schema.sources)
		.values({ slug, title: `Title of ${slug}`, type: 'dictionary', status })
		.returning({ id: schema.sources.id });
	return row.id;
}

describe('resolveSlug', () => {
	it('returns the current slug for a retired one', async () => {
		const id = await seedSource('1875-dobrotvorsky-ainu-russian-dictionary');
		await db.insert(schema.slugRedirects).values({ oldSlug: '1875-x-14odq2e', sourceId: id });
		expect(await resolveSlug(db, '1875-x-14odq2e')).toBe(
			'1875-dobrotvorsky-ainu-russian-dictionary'
		);
	});

	it('returns undefined for a slug that was never retired', async () => {
		await seedSource('some-live-slug');
		expect(await resolveSlug(db, 'unknown-slug')).toBeUndefined();
		// a LIVE slug is not a redirect either — the routes resolve it directly
		expect(await resolveSlug(db, 'some-live-slug')).toBeUndefined();
	});

	it('collapses multi-rename chains to ONE hop (redirects store the source id)', async () => {
		const id = await seedSource('third-slug');
		await db.insert(schema.slugRedirects).values({ oldSlug: 'first-slug', sourceId: id });
		await db.insert(schema.slugRedirects).values({ oldSlug: 'second-slug', sourceId: id });
		expect(await resolveSlug(db, 'first-slug')).toBe('third-slug');
		expect(await resolveSlug(db, 'second-slug')).toBe('third-slug');
	});

	it('follows a rename onto a merged loser (its page 302s onward to the winner)', async () => {
		const id = await seedSource('merged-loser', 'merged');
		await db.insert(schema.slugRedirects).values({ oldSlug: 'old-loser-slug', sourceId: id });
		expect(await resolveSlug(db, 'old-loser-slug')).toBe('merged-loser');
	});

	it('does NOT redirect to a source the public site would 404 anyway', async () => {
		for (const status of ['hidden', 'soft_deleted', 'candidate', 'deprecated']) {
			const id = await seedSource(`${status}-slug`, status);
			await db.insert(schema.slugRedirects).values({ oldSlug: `old-${status}`, sourceId: id });
			expect(await resolveSlug(db, `old-${status}`)).toBeUndefined();
		}
	});
});
