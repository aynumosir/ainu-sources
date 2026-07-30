import type { RequestEvent } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { resolveArchivePrincipal } from './authz';
import { getUsageSummary, listPendingReview } from './db';
import { archiveRoleAtLeast } from './types';
import { archiveDisplayName } from '$lib/archive/identity';
import type { ArchiveUsage } from '$lib/archive/usage.svelte';
import type { ArchivePrincipal } from './types';

export type ArchiveLayoutData =
	| {
			principal: null;
			login: string | null;
			hasAppSession: boolean;
			signInHref: string;
			usage: null;
			pendingCount: 0;
			displayName: null;
		}
	| {
			principal: ArchivePrincipal;
			login: null;
			hasAppSession: boolean;
			signInHref: string;
			usage: ArchiveUsage;
			pendingCount: number;
			displayName: string;
		};

// /archive/+layout.server.ts and /archive/work/[slug]/+layout.server.ts both
// need this same bundle for every request under /archive — the latter runs
// in parallel with (not nested under, typing-wise) the former because of the
// +layout@ reset, so there is no `parent()` to share it through. Caching on
// event.locals, which SvelteKit guarantees is the same object across every
// load function for one request, means the actual session/DB lookups still
// happen exactly once regardless of how many layouts ask for it.
const CACHE_KEY = Symbol('archiveLayoutData');

export function resolveArchiveLayoutData(event: RequestEvent): Promise<ArchiveLayoutData> {
	const locals = event.locals as Record<symbol, Promise<ArchiveLayoutData> | undefined>;
	let cached = locals[CACHE_KEY];
	if (!cached) {
		cached = computeArchiveLayoutData(event);
		locals[CACHE_KEY] = cached;
	}
	return cached;
}

async function computeArchiveLayoutData(event: RequestEvent): Promise<ArchiveLayoutData> {
	const { request, locals, url } = event;
	const principal = await resolveArchivePrincipal(request, db);
	if (!principal) {
		return {
			principal: null,
			login: locals.user?.name?.trim() || locals.user?.email || null,
			hasAppSession: !!locals.user,
			signInHref: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
			usage: null,
			pendingCount: 0,
			displayName: null
		};
	}
	const [usage, pendingReview] = await Promise.all([
		principal.authn === 'mcp_assertion' ? null : getUsageSummary(db, principal),
		archiveRoleAtLeast(principal.role, 'archive_reviewer') ? listPendingReview(db, null, 1) : null
	]);
	return {
		principal,
		login: null,
		hasAppSession: !!locals.user,
		signInHref: `/login?redirect=${encodeURIComponent(url.pathname + url.search)}`,
		usage,
		pendingCount: pendingReview?.total ?? 0,
		displayName: archiveDisplayName(locals.user?.name, principal.email ?? locals.user?.email, principal.role)
	};
}
