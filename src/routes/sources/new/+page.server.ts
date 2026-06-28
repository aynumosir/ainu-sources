import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createSource, mergeNotice } from '$lib/server/queries';
import { parseSourceForm, revisionSummary } from '$lib/server/form';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=' + encodeURIComponent(url.pathname));
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		// Open editing is a feature: any signed-in account may create a source.
		// Changes are attributed + versioned in sourceRevisions (wiki-style), so
		// we gate on authentication only — ownership/roles are intentionally absent.
		if (!locals.user) return fail(401, { error: 'Sign in to edit.' });
		const fd = await request.formData();
		const { input, error } = parseSourceForm(fd);
		if (!input) return fail(400, { error });
		const { slug, result } = await createSource(
			input,
			{ id: locals.user.id, name: locals.user.name },
			revisionSummary(fd)
		);
		// The merge engine may hold/reject part of an edit below a higher-confidence
		// value — surface that instead of silently discarding it (N4). A clean apply
		// (the normal case for an editorial edit) redirects exactly as before.
		const notice = mergeNotice(result);
		if (!slug || notice) return fail(notice ? 409 : 422, { error: notice ?? 'Could not create the source.' });
		redirect(303, '/sources/' + slug);
	}
};
