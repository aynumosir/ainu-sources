import type { JWTPayload } from 'jose';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { env } from '$env/dynamic/private';
import { appUserRoles, userIdentities } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { recordArchiveEvent } from './audit';
import { ArchiveHttpError } from './errors';
import { verifyMcpAssertion } from './mcp-assertion';
import { archiveRoleAtLeast, isArchiveRole, type ArchivePrincipal, type ArchiveRole } from './types';
import { safeEqual } from './crypto';

type Db = LibSQLDatabase<typeof schema>;
type IdentityKind = ArchivePrincipal['identity']['kind'];
type ResolvedIdentity = { userId: string; kind: IdentityKind; value: string };
export type ArchiveResolvedIdentity = { login: string };

let jwksDomain: string | undefined;
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

function accessIssuer(teamDomain: string): string {
	return `https://${teamDomain}`;
}

function accessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
	if (!jwks || jwksDomain !== teamDomain) {
		jwksDomain = teamDomain;
		jwks = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
	}
	return jwks;
}

function getStringClaim(payload: JWTPayload, keys: string[]): string | null {
	for (const key of keys) {
		const value = (payload as Record<string, unknown>)[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	const identity = (payload as Record<string, unknown>).identity;
	if (identity && typeof identity === 'object') {
		for (const key of keys) {
			const value = (identity as Record<string, unknown>)[key];
			if (typeof value === 'string' && value.trim()) return value.trim();
		}
	}
	return null;
}

function hasOrgMembership(payload: JWTPayload): boolean {
	const record = payload as Record<string, unknown>;
	if (record.github_org_member === true || record.aynumosir_org_member === true) return true;
	const org = record.organization;
	if (org && typeof org === 'object' && (org as Record<string, unknown>).member === true) return true;
	const groups = record.groups;
	return Array.isArray(groups) && groups.includes('aynumosir');
}

function parseServiceTokens(raw: string | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const entry of (raw ?? '').split(/[\s,]+/u)) {
		const [id, secret] = entry.split(':');
		if (id && secret) out.set(id, secret);
	}
	return out;
}

async function resolveIdentity(db: Db, kind: IdentityKind, value: string): Promise<ResolvedIdentity | null> {
	const [row] = await db
		.select()
		.from(userIdentities)
		.where(and(eq(userIdentities.kind, kind), eq(userIdentities.value, value)))
		.limit(1);
	return row ? { userId: row.userId, kind, value } : null;
}

async function roleForUser(db: Db, userId: string): Promise<ArchiveRole | null> {
	const [row] = await db.select().from(appUserRoles).where(eq(appUserRoles.userId, userId)).limit(1);
	return isArchiveRole(row?.role) ? row.role : null;
}

async function resolveFromServiceToken(request: Request, db: Db): Promise<ArchivePrincipal | null> {
	const id = request.headers.get('cf-access-client-id');
	const secret = request.headers.get('cf-access-client-secret');
	if (!id || !secret) return null;
	const expected = parseServiceTokens(env.ACCESS_SERVICE_TOKENS).get(id);
	if (!expected || !safeEqual(secret, expected)) return null;
	const identity = await resolveIdentity(db, 'service_token', id);
	if (!identity) return null;
	const role = await roleForUser(db, identity.userId);
	if (!role) return null;
	return { userId: identity.userId, role, identity, authn: 'service_token' };
}

async function resolveIdentityFromServiceToken(request: Request, db: Db): Promise<ArchiveResolvedIdentity | null> {
	const id = request.headers.get('cf-access-client-id');
	const secret = request.headers.get('cf-access-client-secret');
	if (!id || !secret) return null;
	const expected = parseServiceTokens(env.ACCESS_SERVICE_TOKENS).get(id);
	if (!expected || !safeEqual(secret, expected)) return null;
	const identity = await resolveIdentity(db, 'service_token', id);
	return identity ? { login: identity.value } : null;
}

export async function resolveFromMcpAssertion(request: Request, db: Db): Promise<ArchivePrincipal | null> {
	if (!request.headers.get('x-archive-assertion') || !request.headers.get('x-archive-signature')) return null;
	const secret = env.ASSERTION_KEY_MCP;
	if (!secret) throw new ArchiveHttpError(503, 'archive MCP assertion auth is not configured');
	const result = await verifyMcpAssertion(request.headers, secret);
	if (!result.ok) return null;
	const identity = await resolveIdentity(db, 'github_login', result.actor);
	if (!identity) return null;
	return { userId: identity.userId, role: 'archive_reader', identity, authn: 'mcp_assertion' };
}

async function maybeDeactivateMembership(db: Db, userId: string, actor: string): Promise<void> {
	if (env.ARCHIVE_ENFORCE_MEMBERSHIP !== '1') return;
	await db.transaction(async (tx) => {
		const [row] = await tx.select().from(appUserRoles).where(eq(appUserRoles.userId, userId)).limit(1);
		if (!isArchiveRole(row?.role)) return;
		await tx.delete(appUserRoles).where(eq(appUserRoles.userId, userId));
		await recordArchiveEvent(tx, {
			entityType: 'user',
			entityId: userId,
			eventType: 'membership_deactivated',
			actor,
			details: { reason: 'github_org_membership_absent' }
		});
	});
}

async function resolveFromAccessJwt(request: Request, db: Db): Promise<ArchivePrincipal | null> {
	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return null;
	const teamDomain = env.ACCESS_TEAM_DOMAIN;
	const audience = env.ACCESS_AUD;
	if (!teamDomain || !audience) throw new ArchiveHttpError(503, 'archive Access auth is not configured');
	const { payload } = await jwtVerify(token, accessJwks(teamDomain), {
		issuer: accessIssuer(teamDomain),
		audience
	});
	if (typeof payload.sub !== 'string' || !payload.sub) return null;
	const email = getStringClaim(payload, ['email']);
	const githubLogin = getStringClaim(payload, [
		'github_login',
		'login',
		'preferred_username',
		'custom:github_login'
	]);
	let identity = await resolveIdentity(db, 'access_sub', payload.sub);
	if (!identity && githubLogin) identity = await resolveIdentity(db, 'github_login', githubLogin);
	if (!identity) return null;
	if (!hasOrgMembership(payload)) {
		await maybeDeactivateMembership(db, identity.userId, identity.userId);
		return null;
	}
	const role = await roleForUser(db, identity.userId);
	if (!role) return null;
	return { userId: identity.userId, role, identity, authn: 'access_jwt', email: email ?? undefined };
}

async function resolveIdentityFromAccessJwt(request: Request, db: Db): Promise<ArchiveResolvedIdentity | null> {
	const token = request.headers.get('cf-access-jwt-assertion');
	if (!token) return null;
	const teamDomain = env.ACCESS_TEAM_DOMAIN;
	const audience = env.ACCESS_AUD;
	if (!teamDomain || !audience) throw new ArchiveHttpError(503, 'archive Access auth is not configured');
	const { payload } = await jwtVerify(token, accessJwks(teamDomain), {
		issuer: accessIssuer(teamDomain),
		audience
	});
	if (typeof payload.sub !== 'string' || !payload.sub) return null;
	const email = getStringClaim(payload, ['email']);
	const githubLogin = getStringClaim(payload, [
		'github_login',
		'login',
		'preferred_username',
		'custom:github_login'
	]);
	let identity = await resolveIdentity(db, 'access_sub', payload.sub);
	if (!identity && githubLogin) identity = await resolveIdentity(db, 'github_login', githubLogin);
	if (!identity) return { login: githubLogin ?? email ?? payload.sub };
	if (!hasOrgMembership(payload)) {
		await maybeDeactivateMembership(db, identity.userId, identity.userId);
	}
	return { login: githubLogin ?? email ?? identity.value };
}

export async function resolveArchivePrincipal(request: Request, db: Db): Promise<ArchivePrincipal | null> {
	return (
		(await resolveFromServiceToken(request, db)) ??
		(await resolveFromMcpAssertion(request, db)) ??
		(await resolveFromAccessJwt(request, db))
	);
}

export async function resolveArchiveIdentity(request: Request, db: Db): Promise<ArchiveResolvedIdentity | null> {
	return (
		(await resolveIdentityFromServiceToken(request, db)) ??
		(await resolveIdentityFromAccessJwt(request, db))
	);
}

export async function requireArchiveRole(
	request: Request,
	db: Db,
	minRole: ArchiveRole
): Promise<ArchivePrincipal> {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal || !archiveRoleAtLeast(principal.role, minRole)) {
		throw new ArchiveHttpError(403, 'archive role required');
	}
	return principal;
}

export const archiveAuthzInternals = { roleForUser, hasOrgMembership, parseServiceTokens };
