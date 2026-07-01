/**
 * Bun preload shim for running SvelteKit server code as a standalone script.
 *
 * `scripts/review-proposals.ts` imports the merge engine, which imports two
 * SvelteKit build-time virtual modules that `bun` cannot resolve on its own:
 *
 *   • `$env/dynamic/private`   → the injected env object (we back it with process.env)
 *   • `$lib/paraglide/runtime` → the generated i18n runtime (a `getLocale` stub is
 *                                enough; the reviewer never localizes)
 *
 * Registered via `bun --preload ./scripts/sveltekit-env-shim.ts …` so the virtual
 * modules exist BEFORE the entrypoint's imports are resolved. This mirrors what
 * `vitest.config.ts` does for the test runner (its `$env/dynamic/private` /
 * `$lib/paraglide/runtime` aliases) — same virtual modules, different runtime.
 */
import { plugin } from 'bun';

plugin({
	name: 'sveltekit-virtual-modules',
	setup(build) {
		build.module('$env/dynamic/private', () => ({
			contents: 'export const env = process.env;',
			loader: 'js'
		}));
		build.module('$lib/paraglide/runtime', () => ({
			contents: 'export function getLocale() { return "en"; }',
			loader: 'js'
		}));
	}
});
