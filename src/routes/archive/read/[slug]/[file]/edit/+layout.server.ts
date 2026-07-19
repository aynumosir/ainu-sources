import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { getUsageSummary, listPendingReview } from '$lib/server/archive/db';
import { archiveRoleAtLeast } from '$lib/server/archive/types';
import { archiveDisplayName } from '$lib/archive/identity';

export const load: LayoutServerLoad = async ({ request, locals, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) {
		return {
			principal: null,
			login: locals.user?.name?.trim() || locals.user?.email || null,
			hasAppSession: !!locals.user,
			signInHref: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
			usage: null,
			pendingCount: 0
		};
	}
	const usage = principal.authn === 'mcp_assertion' ? null : await getUsageSummary(db, principal);
	const pendingCount = archiveRoleAtLeast(principal.role, 'archive_reviewer')
		? (await listPendingReview(db, null, 1)).total
		: 0;
	return {
		principal,
		login: null,
		displayName: archiveDisplayName(locals.user?.name, principal.email ?? locals.user?.email, principal.role),
		usage,
		pendingCount
	};
};
