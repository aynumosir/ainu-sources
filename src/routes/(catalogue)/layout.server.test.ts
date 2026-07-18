import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { env } from '$env/dynamic/private';
import { archiveAuthzInternals } from '$lib/server/archive/authz';
import { user } from '$lib/server/db/auth.schema';
import * as schema from '$lib/server/db/schema';

const MIGRATIONS = fileURLToPath(new URL('../../../drizzle', import.meta.url));

type Db = LibSQLDatabase<typeof schema>;
type RouteModule = typeof import('./+layout.server');
type LoadEvent = Parameters<RouteModule['load']>[0];
type SessionUser = { id: string; name: string; email: string };

let db: Db;
let load: RouteModule['load'];
let testDir: string;

function eventFor(sessionUser: SessionUser | null): LoadEvent {
	return {
		request: new Request('https://example.test/'),
		locals: { user: sessionUser ?? undefined }
	} as unknown as LoadEvent;
}

async function insertUser(sessionUser: SessionUser): Promise<void> {
	await db.insert(user).values(sessionUser);
}

describe('catalogue layout server load', () => {
	beforeAll(async () => {
		testDir = await mkdtemp(join(tmpdir(), 'catalogue-layout-test-'));
		env.DATABASE_URL = `file:${join(testDir, 'db.sqlite')}`;
		const client = createClient({ url: env.DATABASE_URL });
		db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: MIGRATIONS });
		({ load } = await import('./+layout.server'));
	});

	beforeEach(async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(async () => null);
		await db.delete(schema.appUserRoles);
		await db.delete(schema.githubLoginCache);
		await db.delete(schema.userIdentities);
		await db.delete(user);
	});

	afterAll(async () => {
		archiveAuthzInternals.setAppSessionLookupForTest(null);
		await rm(testDir, { recursive: true, force: true });
	});

	it('returns no archive access for signed-out users', async () => {
		const result = await load(eventFor(null));

		expect(result).toMatchObject({
			user: null,
			hasArchiveAccess: false
		});
	});

	it('returns no archive access for signed-in users without an archive role', async () => {
		const sessionUser = { id: 'catalogue-user', name: 'Catalogue User', email: 'catalogue@example.test' };
		await insertUser(sessionUser);
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({
			id: sessionUser.id,
			email: sessionUser.email
		}));

		const result = await load(eventFor(sessionUser));

		expect(result).toMatchObject({
			user: sessionUser,
			hasArchiveAccess: false
		});
	});

	it('returns archive access for signed-in archive readers', async () => {
		const sessionUser = { id: 'archive-reader', name: 'Archive Reader', email: 'reader@example.test' };
		await insertUser(sessionUser);
		await db.insert(schema.appUserRoles).values({
			userId: sessionUser.id,
			role: 'archive_reader'
		});
		archiveAuthzInternals.setAppSessionLookupForTest(async () => ({
			id: sessionUser.id,
			email: sessionUser.email
		}));

		const result = await load(eventFor(sessionUser));

		expect(result).toMatchObject({
			user: sessionUser,
			hasArchiveAccess: true
		});
	});
});
