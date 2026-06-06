import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { createClient as createWebClient } from '@libsql/client/web';
import { createClient as createNodeClient } from '@libsql/client';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

type DB = LibSQLDatabase<typeof schema>;

// On Cloudflare Workers we MUST use the HTTP-only web client for remote
// (libsql://, https://) URLs. The default client opens a persistent Hrana
// WebSocket and holds it at module scope, shared across every request. Once
// the request that opened the socket finishes, in-flight queries from other
// requests have their promise continuations canceled by the runtime — the
// request then hangs and the runtime returns a 500 ("Worker's code had hung").
// This surfaces as the "promise resolved from a different request context"
// warning and clusters on pages that fan out many parallel loads (e.g.
// /timeline prefetching dozens of /sources/*/__data.json). The web client
// issues a stateless fetch per query, so each continuation stays in its own
// request context. Local dev uses a file: URL, which only the node client
// supports.
function connect(): DB {
	const url = env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	const isFile = url.startsWith('file:');
	if (!isFile && !env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');
	const client = isFile
		? createNodeClient({ url, authToken: env.DATABASE_AUTH_TOKEN })
		: createWebClient({ url, authToken: env.DATABASE_AUTH_TOKEN });
	return drizzle(client, { schema });
}

// Connect lazily, on first property access — NOT at import. SvelteKit's
// post-build `analyse` step imports every server module, so a top-level
// `throw`/connect here crashed `vite build` in CI, where the build container
// has no DATABASE_URL. Deferring means the build never needs DB credentials —
// only the running Worker does, and that's where the secret is actually set.
let instance: DB | undefined;
export const db: DB = new Proxy({} as DB, {
	get(_target, prop) {
		instance ??= connect();
		const value = instance[prop as keyof DB];
		return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(instance) : value;
	}
});
