import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auth } from '$lib/server/auth';
import { APIError } from 'better-auth/api';
import { env } from '$env/dynamic/private';

export const load: PageServerLoad = async ({ locals, request }) => {
	if (!locals.user) redirect(302, '/login?redirect=/account');
	let providers: string[] = [];
	try {
		const accounts = await auth.api.listUserAccounts({ headers: request.headers });
		providers = (accounts ?? []).map((a) => a.providerId);
	} catch {
		// non-fatal — just show no linked accounts
	}
	return {
		user: { name: locals.user.name, email: locals.user.email },
		providers,
		githubEnabled: !!env.GITHUB_CLIENT_ID
	};
};

export const actions: Actions = {
	signout: async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, '/');
	},

	linkGithub: async ({ request }) => {
		const res = await auth.api.linkSocialAccount({
			body: { provider: 'github', callbackURL: '/account' },
			headers: request.headers
		});
		if (res?.url) redirect(303, res.url);
		return fail(400, { message: 'GitHub linking is not configured.' });
	},

	unlinkGithub: async ({ request }) => {
		try {
			await auth.api.unlinkAccount({ body: { providerId: 'github' }, headers: request.headers });
		} catch (e) {
			if (e instanceof APIError)
				return fail(400, { message: e.message || 'Could not disconnect GitHub.' });
			throw e;
		}
		return { unlinked: true };
	}
};
