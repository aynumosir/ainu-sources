import { error } from '@sveltejs/kit';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { db as defaultDb } from '$lib/server/db';
import type * as schema from '$lib/server/db/schema';
import { requireArchiveRole } from './authz';
import { requireArchiveMutationGuards } from './csrf';
import { ArchiveHttpError } from './errors';
import type { ArchivePrincipal, ArchiveRole } from './types';

type Db = LibSQLDatabase<typeof schema>;

export function archiveRouteDb(locals: App.Locals): Db {
	return (locals as App.Locals & { archiveDb?: Db }).archiveDb ?? defaultDb;
}

export async function archivePrincipal(
	request: Request,
	minRole: ArchiveRole,
	db: Db = defaultDb
): Promise<ArchivePrincipal> {
	try {
		return await requireArchiveRole(request, db, minRole);
	} catch (e) {
		throwArchiveError(e);
	}
}

export async function archiveMutationPrincipal(
	request: Request,
	minRole: ArchiveRole,
	db: Db = defaultDb
): Promise<ArchivePrincipal> {
	const principal = await archivePrincipal(request, minRole, db);
	try {
		if (principal.authn === 'mcp_assertion') {
			throw new ArchiveHttpError(403, 'assertion-authenticated principals cannot perform mutating actions');
		}
		if (principal.authn !== 'service_token') {
			await requireArchiveMutationGuards(request, principal.userId);
		}
		return principal;
	} catch (e) {
		throwArchiveError(e);
	}
}

export function throwArchiveError(e: unknown): never {
	if (e instanceof ArchiveHttpError) {
		throw error(e.status, { message: e.message, ...e.details } as App.Error);
	}
	throw e;
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'expected a JSON object body');
	}
	if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'expected a JSON object body');
	return body as Record<string, unknown>;
}

export function bearerValue(request: Request): string | null {
	const m = /^Bearer\s+(.+)$/iu.exec(request.headers.get('authorization') ?? '');
	return m?.[1] ?? null;
}
