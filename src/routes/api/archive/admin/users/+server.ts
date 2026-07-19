import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db as defaultDb } from '$lib/server/db';
import { listArchiveUsers } from '$lib/server/archive/db';
import { archivePrincipal, throwArchiveError } from '$lib/server/archive/route';

export const GET: RequestHandler = async ({ request, locals }) => {
	const db = routeDb(locals);
	await archivePrincipal(request, 'archive_admin', db);
	try {
		const users = await listArchiveUsers(db);
		return json({
			users,
			totalUsers: users.length,
			archiveUserCount: users.filter((user) => user.role !== null).length
		});
	} catch (e) {
		throwArchiveError(e);
	}
};

function routeDb(locals: App.Locals) {
	return (locals as App.Locals & { archiveDb?: typeof defaultDb }).archiveDb ?? defaultDb;
}
