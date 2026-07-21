import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { env } from '$env/dynamic/private';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { captureGithubAccountEvent, rememberGithubProfileLogin } from '$lib/server/archive/github-login-capture';

type Auth = ReturnType<typeof betterAuth>;

function build(): Auth {
	return betterAuth({
		baseURL: env.ORIGIN,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(db, { provider: 'sqlite' }),
		emailAndPassword: { enabled: true },
		socialProviders: {
			github: {
				clientId: env.GITHUB_CLIENT_ID,
				clientSecret: env.GITHUB_CLIENT_SECRET,
				mapProfileToUser(profile) {
					rememberGithubProfileLogin(String(profile.id), profile.login);
					return {};
				}
			}
		},
		databaseHooks: {
			account: {
				create: { after: (account) => captureGithubAccountEvent(account) },
				update: { after: (account) => captureGithubAccountEvent(account) }
			}
		},
		plugins: [
			sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
		]
	});
}

// Build lazily, on first access — NOT at import. better-auth reads its secret /
// base URL eagerly and throws when they're unset, which crashed `vite build`'s
// post-build analyse step in CI (no env there). Deferring to first use means the
// build needs no auth secrets; the running Worker (where they're set) does.
let instance: Auth | undefined;
export const auth: Auth = new Proxy({} as Auth, {
	get(_target, prop) {
		instance ??= build();
		const value = instance[prop as keyof Auth];
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(instance) : value;
	}
});
