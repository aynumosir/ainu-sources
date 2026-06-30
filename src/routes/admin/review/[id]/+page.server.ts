import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { isModerator } from '$lib/server/authz';
import { db } from '$lib/server/db';
import { getChangeRequestDetail } from '$lib/server/review-queue';
import { reviewChangeRequest, ChangeRequestStale } from '$lib/server/merge';
import type { ReviewResult } from '$lib/server/merge';

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

/** A moderator's audit-only actor descriptor (id preferred; never affects precedence). */
function actorOf(user: { id: string; name?: string | null }): string {
	return user.id ?? user.name ?? 'moderator';
}

/**
 * Each action is ONE call to the merge engine (`reviewChangeRequest`), which itself
 * is a single statement / one `db.batch` — NO `db.transaction()`. Every action is
 * re-gated with `isModerator` (an editor can create proposals but never approve).
 * A `ChangeRequestStale` (409) — the proposal moved under the reviewer, e.g. it
 * became conflicting on the live re-plan — is surfaced as a friendly "re-review"
 * message rather than a 500.
 */
async function runReview(
	crId: string,
	locals: App.Locals,
	verdict: 'apply' | 'reject' | 'needs_evidence',
	formReason: FormDataEntryValue | null,
	fallbackReason: string
): Promise<{ ok: true; status: ReviewResult['status']; message: string }> {
	const reason = typeof formReason === 'string' && formReason.trim() ? formReason.trim() : fallbackReason;
	const result = await reviewChangeRequest(db, crId, {
		reviewerKind: 'human',
		reviewerActor: actorOf(locals.user!),
		verdict,
		reason
	});
	const messages: Record<ReviewResult['status'], string> = {
		applied: 'Proposal approved and applied through the merge engine.',
		approved: 'Recorded.',
		rejected: 'Proposal rejected.',
		needs_evidence: 'Sent back for more evidence.'
	};
	return { ok: true, status: result.status, message: messages[result.status] };
}

function gate(locals: App.Locals) {
	if (!locals.user) return fail(401, { error: 'Sign in to review.' });
	if (!isModerator(locals.user)) return fail(403, { error: 'Moderators only.' });
	return null;
}

const STALE_MESSAGE =
	'This proposal changed since you opened it — it was sent back for re-review. Reload and review the updated diff.';

export const actions: Actions = {
	// Approve → reviewChangeRequest(verdict:'apply', human) → drives applyChangeRequest.
	approve: async ({ params, locals, request }) => {
		const denied = gate(locals);
		if (denied) return denied;
		const fd = await request.formData();
		try {
			return await runReview(params.id, locals, 'apply', fd.get('reason'), 'Approved by moderator.');
		} catch (e) {
			if (e instanceof ChangeRequestStale) return fail(409, { error: STALE_MESSAGE });
			throw e;
		}
	},

	// Reject → reviewChangeRequest(verdict:'reject', human): CR + observation rejected.
	reject: async ({ params, locals, request }) => {
		const denied = gate(locals);
		if (denied) return denied;
		const fd = await request.formData();
		try {
			return await runReview(params.id, locals, 'reject', fd.get('reason'), 'Rejected by moderator.');
		} catch (e) {
			if (e instanceof ChangeRequestStale) return fail(409, { error: STALE_MESSAGE });
			throw e;
		}
	},

	// Request evidence → reviewChangeRequest(verdict:'needs_evidence', human).
	requestEvidence: async ({ params, locals, request }) => {
		const denied = gate(locals);
		if (denied) return denied;
		const fd = await request.formData();
		try {
			return await runReview(
				params.id,
				locals,
				'needs_evidence',
				fd.get('reason'),
				'More evidence requested by moderator.'
			);
		} catch (e) {
			if (e instanceof ChangeRequestStale) return fail(409, { error: STALE_MESSAGE });
			throw e;
		}
	}
};
