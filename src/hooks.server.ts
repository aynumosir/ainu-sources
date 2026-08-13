import { sequence } from '@sveltejs/kit/hooks';
import { building } from '$app/environment';
import { auth, settleAuthContext } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import type { Handle, ServerInit } from '@sveltejs/kit';
import { getTextDirection } from '$lib/paraglide/runtime';
import { paraglideMiddleware } from '$lib/paraglide/server';
import { handleEdgeCache } from '$lib/server/edge-cache';

// adapter-cloudflare starts `server.init` at module scope and gates every fetch
// on it, so this runs during isolate startup with `$env/dynamic/private` already
// populated, the promise chain owned by module scope, and no request reaching
// `getSession` while the auth context is still pending. Prerendering also calls
// `server.init`, with `building` set and no secrets — hence the guard. A failed
// settlement is rethrown: the isolate cannot authenticate anyway, and the logged
// line names the cause once where per-request exceptions would name it never.
export const init: ServerInit = async () => {
	if (building) return;
	try {
		await settleAuthContext();
	} catch (error) {
		console.error('[auth] context failed to settle at startup:', error);
		throw error;
	}
};

const handleParaglide: Handle = ({ event, resolve }) => paraglideMiddleware(event.request, ({ request, locale }) => {
	event.request = request;

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%paraglide.lang%', locale).replace('%paraglide.dir%', getTextDirection(locale))
	});
});

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

// The cache sits outermost so a hit returns before the session lookup below it —
// that round trip is one of the ones this exists to avoid.
export const handle: Handle = sequence(handleEdgeCache, handleParaglide, handleBetterAuth);
