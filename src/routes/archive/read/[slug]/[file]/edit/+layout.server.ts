import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from '$lib/server/archive/authz';
import { getUsageSummary } from '$lib/server/archive/db';
import { archiveDisplayName } from '$lib/archive/identity';

export const load: LayoutServerLoad = async ({ request, locals, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) {
		return {
			principal: null,
			login: locals.user?.name?.trim() || locals.user?.email || null,
			hasAppSession: !!locals.user,
			signInHref: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
			usage: null
		};
	}
	const usage = principal.authn === 'mcp_assertion' ? null : await getUsageSummary(db, principal);
	return {
		principal,
		login: null,
		displayName: archiveDisplayName(locals.user?.name, principal.email ?? locals.user?.email, principal.role),
		usage
	};
};
