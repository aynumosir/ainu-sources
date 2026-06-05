import { drizzle } from 'drizzle-orm/libsql';
import { createClient as createWebClient } from '@libsql/client/web';
import { createClient as createNodeClient } from '@libsql/client';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const url = env.DATABASE_URL;

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
const isFile = url.startsWith('file:');
if (!isFile && !env.DATABASE_AUTH_TOKEN) throw new Error('DATABASE_AUTH_TOKEN is not set');

const client = isFile
	? createNodeClient({ url, authToken: env.DATABASE_AUTH_TOKEN })
	: createWebClient({ url, authToken: env.DATABASE_AUTH_TOKEN });

export const db = drizzle(client, { schema });
