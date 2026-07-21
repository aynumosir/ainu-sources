import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isModerator } from '$lib/server/authz';
import { db } from '$lib/server/db';
import { getReviewQueue } from '$lib/server/review-queue';

/**
 * The DB-PR review queue (Git-in-the-DB Phase 5). Role-gated: only a moderator /
 * admin (env allowlist today via authz.ts; swaps to app_user_roles later with no
 * route change) may view or act. Anonymous → login; signed-in non-moderator → 403.
 * Open editing stays the default elsewhere — this surface only governs WHO can
 * APPROVE a proposal, never who can create one.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=' + encodeURIComponent(url.pathname));
	if (!isModerator(locals.user)) error(403, 'This area is for moderators.');

	const items = await getReviewQueue(db);
	return { items };
};
