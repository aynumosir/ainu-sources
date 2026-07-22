/**
 * Reveal an element once it scrolls into view: it starts dimmed and a few
 * pixels low, then settles. The optional delay staggers a list of cards so a
 * fresh page eases in rather than popping. Honors reduced-motion and reveals
 * immediately when IntersectionObserver is unavailable.
 */
export function reveal(node: HTMLElement, delay = 0) {
	const reduce =
		typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
	if (reduce || typeof IntersectionObserver === 'undefined') {
		node.style.opacity = '1';
		return {};
	}
	node.style.opacity = '0';
	node.style.transform = 'translateY(10px)';
	node.style.transition = 'opacity 0.5s ease, transform 0.5s cubic-bezier(0.22, 1, 0.36, 1)';
	const settle = () => {
		node.style.opacity = '1';
		node.style.transform = 'none';
	};
	const observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					const id = window.setTimeout(settle, delay);
					observer.disconnect();
					return () => window.clearTimeout(id);
				}
			}
		},
		{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
	);
	observer.observe(node);
	return {
		destroy() {
			observer.disconnect();
		}
	};
}
