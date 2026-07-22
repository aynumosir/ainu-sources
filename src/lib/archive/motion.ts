/** Whether the visitor asked for reduced motion. False during SSR and when unsupported. */
export function prefersReducedMotion(): boolean {
	return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
