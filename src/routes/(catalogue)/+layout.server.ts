import type { LayoutServerLoad } from './$types';
import { resolveFromAppSession } from '$lib/server/archive/authz';
import { db } from '$lib/server/db';

export const load: LayoutServerLoad = async ({ locals, request }) => {
	const archivePrincipal = await resolveFromAppSession(request, db);

	return {
		user: locals.user
			? { id: locals.user.id, name: locals.user.name, email: locals.user.email }
			: null,
		hasArchiveAccess: archivePrincipal !== null
	};
};
