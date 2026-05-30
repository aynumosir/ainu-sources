import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createSource } from '$lib/server/queries';
import { parseSourceForm, revisionSummary } from '$lib/server/form';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login?redirect=' + encodeURIComponent(url.pathname));
	return {};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Sign in to edit.' });
		const fd = await request.formData();
		const { input, error } = parseSourceForm(fd);
		if (!input) return fail(400, { error });
		const slug = await createSource(
			input,
			{ id: locals.user.id, name: locals.user.name },
			revisionSummary(fd)
		);
		redirect(303, '/sources/' + slug);
	}
};
