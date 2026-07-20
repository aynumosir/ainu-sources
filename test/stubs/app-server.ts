// `$app/server` is injected by SvelteKit at build time. Only `getRequestEvent`
// is reached from server modules under test, and no test drives a real request
// event, so calling it is a mistake rather than a case to emulate.
export function getRequestEvent(): never {
	throw new Error('getRequestEvent is not available in unit tests');
}
