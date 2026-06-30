import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { isModerator } from '$lib/server/authz';
import { db } from '$lib/server/db';
import { getChangeRequestDetail } from '$lib/server/review-queue';

/**
 * Change-request detail (Git-in-the-DB Phase 5): the before→after diff, the
 * reviewed observation's evidence / raw payload, the source's current field
 * provenance, the held / rejected claims (shown, never hidden), and every prior
 * review. Same role gate as the queue — moderators only.
 */
export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=' + encodeURIComponent(url.pathname));
	if (!isModerator(locals.user)) error(403, 'This area is for moderators.');

	const detail = await getChangeRequestDetail(db, params.id);
	if (!detail) error(404, 'Change request not found.');

	return { detail };
};
