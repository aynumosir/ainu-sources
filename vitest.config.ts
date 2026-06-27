import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Minimal node-environment setup for the Phase-0 pure-function unit tests.
// We deliberately do NOT pull in the full SvelteKit/browser test plugin: these
// tests exercise plain TS helpers. Two SvelteKit virtual modules are stubbed so
// the imported source files resolve under plain vitest:
//   - `$lib/paraglide/runtime` (generated at build time, absent in a fresh tree)
//   - `$env/dynamic/private`   (SvelteKit-injected env, used by authz.ts)
export default defineConfig({
	resolve: {
		alias: [
			// Order matters: the specific stubs must precede the generic `$lib` map.
			{ find: /^\$lib\/paraglide\/runtime$/, replacement: r('./test/stubs/paraglide-runtime.ts') },
			{ find: /^\$env\/dynamic\/private$/, replacement: r('./test/stubs/env-dynamic-private.ts') },
			{ find: /^\$lib$/, replacement: r('./src/lib') },
			{ find: /^\$lib\//, replacement: r('./src/lib/') }
		]
	},
	test: {
		environment: 'node',
		include: ['src/**/*.{test,spec}.ts'],
		clearMocks: true
	}
});
