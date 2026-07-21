import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { getArchiveUserKind, setArchiveUserRole } from '$lib/server/archive/db';
import { ArchiveHttpError } from '$lib/server/archive/errors';
import { archiveMutationPrincipal, readJsonObject, throwArchiveError } from '$lib/server/archive/route';
import { isArchiveRole, type ArchiveRole } from '$lib/server/archive/types';

export const POST: RequestHandler = async ({ request, params, locals }) => {
	const db = routeDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_admin', db);
	if (principal.authn !== 'app_session') {
		throwArchiveError(new ArchiveHttpError(403, 'role changes require an app-session principal'));
	}
	const body = await readJsonObject(request);
	const role = parseRole(body.role);
	try {
		const targetKind = await getArchiveUserKind(db, params.userId);
		const user = await setArchiveUserRole(db, params.userId, role, principal);
		return json({
			user,
			...(targetKind === 'machine' ? { warning: 'target is a machine principal' } : {})
		});
	} catch (e) {
		throwArchiveError(e);
	}
};

function parseRole(value: unknown): ArchiveRole | null {
	if (value === null) return null;
	if (typeof value === 'string' && isArchiveRole(value)) return value;
	throwArchiveError(new ArchiveHttpError(400, 'invalid archive role'));
}

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
