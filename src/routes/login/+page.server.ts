import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { safePath } from '$lib/server/form';

export const load: PageServerLoad = async ({ locals, url }) => {
	const redirectTo = safePath(url.searchParams.get('redirect'));
	if (locals.user) redirect(302, redirectTo);
	return { redirectTo };
};

export const actions: Actions = {
	signin: async ({ request }) => {
		const fd = await request.formData();
		const email = fd.get('email')?.toString() ?? '';
		const password = fd.get('password')?.toString() ?? '';
		const redirectTo = safePath(fd.get('redirectTo')?.toString());
		try {
			await auth.api.signInEmail({ body: { email, password } });
		} catch (e) {
			if (e instanceof APIError) return fail(400, { message: e.message || 'Sign-in failed' });
			throw e;
		}
		redirect(303, redirectTo);
	},
	github: async ({ request }) => {
		const fd = await request.formData();
		const redirectTo = safePath(fd.get('redirectTo')?.toString());
		const res = await auth.api.signInSocial({
			body: { provider: 'github', callbackURL: redirectTo }
		});
		if (res.url) redirect(303, res.url);
		return fail(400, { message: 'GitHub sign-in is not configured.' });
	}
};
