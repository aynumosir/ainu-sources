import type { LayoutServerLoad } from './$types';
import { resolveArchiveLayoutData } from '$lib/server/archive/layout-data';

// The +layout@ reset below replaces the rendered component tree, not the
// load-data chain, so /archive/+layout.server.ts still runs for this route —
// but SvelteKit's generated parent() typing for a layout nested two levels
// under a directory with no +layout.server.ts of its own (archive/work/) does
// not resolve through to it, so this can't just read it via parent(). Sharing
// the same per-request-cached resolver keeps the actual session/DB lookups
// down to one regardless.
export const load: LayoutServerLoad = (event) => resolveArchiveLayoutData(event);
