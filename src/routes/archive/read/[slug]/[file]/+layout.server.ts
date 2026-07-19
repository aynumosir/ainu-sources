import type { LayoutServerLoad } from './$types';
import { db } from '$lib/server/db';
import { resolveArchiveIdentity, resolveArchivePrincipal } from '$lib/server/archive/authz';
import { getUsageSummary } from '$lib/server/archive/db';

/**
 * The reader resets the layout hierarchy (`+layout@.svelte`) so the scan gets
 * the full viewport, which also cuts it off from the archive layout's data.
 * It therefore resolves the principal itself; without this the reader would
 * always fall through to the access gate.
 */
export const load: LayoutServerLoad = async ({ request, locals, url }) => {
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) {
		const identity = await resolveArchiveIdentity(request, db);
		return {
			principal: null,
			login: identity?.login ?? null,
			hasAppSession: !!locals.user,
			signInHref: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
			usage: null
		};
	}
	const usage = principal.authn === 'mcp_assertion' ? null : await getUsageSummary(db, principal);
	return { principal, login: principal.identity.value, usage };
};
