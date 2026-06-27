// Test stub for the build-time-generated `$lib/paraglide/runtime` module.
// format.ts imports `getLocale` at module load; only that symbol is needed.
// Tests pass an explicit locale where the value matters, so the default here
// just needs to be a valid base locale.
export function getLocale(): string {
	return 'en';
}
