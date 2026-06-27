// Test stub for SvelteKit's `$env/dynamic/private`.
// authz.ts reads `env.ADMIN_USER_IDS` / `env.MODERATOR_USER_IDS` on every call,
// so tests mutate this shared object between cases to drive the allowlists.
export const env: Record<string, string | undefined> = {};
