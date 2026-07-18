import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { db as defaultDb } from '$lib/server/db';
import { githubLoginCache, userIdentities } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import { recordArchiveEvent } from './audit';

type Db = LibSQLDatabase<typeof schema>;

export type GithubAccountEvent = {
	id: string;
	accountId: string;
	providerId: string;
	userId: string;
};

type PendingLogin = {
	login: string;
	expiresAt: number;
};

const LOGIN_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_LOGINS = 128;
const pendingGithubLogins = new Map<string, PendingLogin>();

function pruneGithubProfileLogins(now = Date.now()): void {
	for (const [githubId, entry] of pendingGithubLogins) {
		if (entry.expiresAt > now) continue;
		pendingGithubLogins.delete(githubId);
	}
	while (pendingGithubLogins.size > MAX_PENDING_LOGINS) {
		const oldestKey = pendingGithubLogins.keys().next().value;
		if (oldestKey === undefined) break;
		pendingGithubLogins.delete(oldestKey);
	}
}

export function rememberGithubProfileLogin(githubId: string, login: string): void {
	const normalizedGithubId = githubId.trim();
	const normalizedLogin = login.trim();
	if (!normalizedGithubId || !normalizedLogin) return;
	const now = Date.now();
	pruneGithubProfileLogins(now);
	pendingGithubLogins.delete(normalizedGithubId);
	pendingGithubLogins.set(normalizedGithubId, {
		login: normalizedLogin,
		expiresAt: now + LOGIN_TTL_MS
	});
	pruneGithubProfileLogins(now);
}

export function takeGithubProfileLogin(githubId: string): string | null {
	pruneGithubProfileLogins();
	const entry = pendingGithubLogins.get(githubId);
	if (!entry) return null;
	pendingGithubLogins.delete(githubId);
	return entry.login;
}

export async function captureGithubAccountEvent(
	account: GithubAccountEvent,
	db: Db = defaultDb
): Promise<void> {
	if (account.providerId !== 'github') return;

	// Better Auth exposes GitHub login in mapProfileToUser. The account hooks are
	// the durable write point. This same-request cache carries the login between
	// those two callbacks.
	const login = takeGithubProfileLogin(account.accountId);
	if (!login) return;

	await db.transaction(async (tx) => {
		await tx
			.insert(githubLoginCache)
			.values({ userId: account.userId, login })
			.onConflictDoUpdate({
				target: githubLoginCache.userId,
				set: { login, updatedAt: new Date() }
			});

		const [existingRow] = await tx
			.select()
			.from(userIdentities)
			.where(and(eq(userIdentities.kind, 'github_login'), eq(userIdentities.value, login)))
			.limit(1);

		if (!existingRow) {
			await tx.insert(userIdentities).values({ kind: 'github_login', value: login, userId: account.userId });
			return;
		}
		if (existingRow.userId === account.userId) return;

		// Archive identity claims use first writer wins. Later OAuth claimants are
		// logged, and no silent takeover occurs. The per-user cache still records
		// the login, which supports administrative users pre-provisioned before the
		// person signs in through GitHub OAuth.
		await recordArchiveEvent(tx, {
			entityType: 'user',
			entityId: account.userId,
			eventType: 'github_login_claim_conflict',
			actor: account.userId,
			details: { login, claimedBy: existingRow.userId }
		});
	});
}
