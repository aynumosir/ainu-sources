/**
 * Minimal authorization hook — Phase 0 (code-only, NO DB table).
 *
 * Open editing stays the default posture: any signed-in user is an 'editor',
 * matching the wiki-style model documented in scripts/audit.ts and the source
 * write actions. This module ONLY adds a forward-looking role concept so a
 * future /admin/review route can gate on moderator/admin without another
 * rewrite.
 *
 * The deferred `app_user_roles` table is intentionally NOT introduced here.
 * Until it lands, elevated roles are derived solely from env allowlists
 * (MODERATOR_USER_IDS / ADMIN_USER_IDS) of better-auth user ids, parsed as a
 * comma- or whitespace-separated list. Everyone else resolves to 'editor'.
 *
 * This file is purely additive: it has no call sites yet and does NOT touch
 * /audit (which remains public, read-only).
 */
import { env } from '$env/dynamic/private';

export type Role = 'editor' | 'moderator' | 'admin';

/** The shape we need off App.Locals.user — kept structural to stay decoupled. */
type MaybeUser = { id: string } | null | undefined;

/** Parse a comma/whitespace-separated allowlist env var into a Set of ids. */
function allowlist(raw: string | undefined): Set<string> {
	return new Set(
		(raw ?? '')
			.split(/[\s,]+/)
			.map((s) => s.trim())
			.filter(Boolean)
	);
}

/**
 * Resolve a user's role. Returns null when anonymous. Any signed-in user is at
 * least an 'editor'; admin takes precedence over moderator. Env is read on each
 * call (it is a small object) so an allowlist rotated at runtime is honored
 * without a rebuild — the same approach as requireWriteToken in write-api.ts.
 */
export function roleOf(user: MaybeUser): Role | null {
	if (!user) return null;
	if (allowlist(env.ADMIN_USER_IDS).has(user.id)) return 'admin';
	if (allowlist(env.MODERATOR_USER_IDS).has(user.id)) return 'moderator';
	return 'editor';
}

/** True when the user is an admin. */
export function isAdmin(user: MaybeUser): boolean {
	return roleOf(user) === 'admin';
}

/** True when the user is a moderator or admin (admins are a moderator superset). */
export function isModerator(user: MaybeUser): boolean {
	const r = roleOf(user);
	return r === 'moderator' || r === 'admin';
}
