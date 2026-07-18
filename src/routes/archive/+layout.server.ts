import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { resolveArchiveIdentity, resolveArchivePrincipal } from '$lib/server/archive/authz';
import { getUsageSummary, listPendingReview } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';

export const load: LayoutServerLoad = async ({ request }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) {
		const identity = await resolveArchiveIdentity(request, db);
		return { principal: null, login: identity?.login ?? null, usage: null, pendingCount: 0 };
	}
	const usage = principal.authn === 'mcp_assertion' ? null : await getUsageSummary(db, principal);
	const pendingCount = archiveRoleAtLeast(principal.role, 'archive_reviewer')
		? (await listPendingReview(db, null, 1)).total
		: 0;
	return { principal, login: principal.identity.value, usage, pendingCount };
};
