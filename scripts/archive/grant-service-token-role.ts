#!/usr/bin/env bun
/**
 * Grant an archive role to a Cloudflare Access service-token identity.
 *
 * Connection:
 *   --db <DATABASE_URL>      or DATABASE_URL
 *   --token <AUTH_TOKEN>     or DATABASE_AUTH_TOKEN for remote DBs
 *
 * Usage:
 *   bun scripts/archive/grant-service-token-role.ts \
 *     --service-token-id <cf-access-client-id> \
 *     --role archive_contributor
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../../src/lib/server/db/schema';

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
	const eqForm = process.argv.find((a) => a.startsWith(`${flag}=`));
	return eqForm ? eqForm.slice(flag.length + 1) : undefined;
}

const url = argValue('--db') ?? process.env.DATABASE_URL;
if (!url) {
	console.error('✗ No database specified. Pass --db <url> or set DATABASE_URL.');
	process.exit(1);
}
const isFile = url.startsWith('file:');
const authToken = argValue('--token') ?? process.env.DATABASE_AUTH_TOKEN;
if (!isFile && !authToken) {
	console.error('✗ Remote DATABASE_URL given but no auth token (--token or DATABASE_AUTH_TOKEN).');
	process.exit(1);
}

const serviceTokenId = argValue('--service-token-id')?.trim();
if (!serviceTokenId) {
	console.error('✗ --service-token-id is required.');
	process.exit(1);
}

const role = argValue('--role')?.trim() ?? 'archive_contributor';
const allowedRoles = new Set(['archive_reader', 'archive_contributor', 'archive_reviewer', 'archive_admin']);
if (!allowedRoles.has(role)) {
	console.error(`✗ Invalid archive role: ${role}`);
	process.exit(1);
}

const userId = argValue('--user-id')?.trim() || 'service-token:archive-cli';
const email = argValue('--email')?.trim() || 'archive-cli@service-token.archive.local';
const name = argValue('--name')?.trim() || 'Archive CLI service token';
const now = new Date();

const client = createClient({ url, authToken: authToken || undefined });
const db = drizzle(client, { schema });

await db.transaction(async (tx) => {
	await tx
		.insert(schema.user)
		.values({
			id: userId,
			name,
			email,
			emailVerified: true,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoUpdate({
			target: schema.user.id,
			set: { name, email, emailVerified: true, updatedAt: now }
		});

	await tx
		.insert(schema.userIdentities)
		.values({ userId, kind: 'service_token', value: serviceTokenId, createdAt: now })
		.onConflictDoUpdate({
			target: [schema.userIdentities.kind, schema.userIdentities.value],
			set: { userId }
		});

	await tx
		.insert(schema.appUserRoles)
		.values({ userId, role, createdAt: now, updatedAt: now })
		.onConflictDoUpdate({
			target: schema.appUserRoles.userId,
			set: { role, updatedAt: now }
		});
});

console.log(`Granted ${role} to service token identity.`);
