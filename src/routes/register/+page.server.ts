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
	default: async ({ request }) => {
		const fd = await request.formData();
		const email = fd.get('email')?.toString() ?? '';
		const password = fd.get('password')?.toString() ?? '';
		const name = fd.get('name')?.toString()?.trim() || email.split('@')[0];
		const redirectTo = safePath(fd.get('redirectTo')?.toString());
		try {
			await auth.api.signUpEmail({ body: { email, password, name } });
		} catch (e) {
			if (e instanceof APIError) return fail(400, { message: e.message || 'Registration failed' });
			throw e;
		}
		redirect(303, redirectTo);
	}
};
