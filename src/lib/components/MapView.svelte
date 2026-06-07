<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { MapPlace } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { OSM_STYLE } from '$lib/map-style';

	let { places, height = '70vh' }: { places: MapPlace[]; height?: string } = $props();

	let el = $state<HTMLDivElement>();

	const REGION_COLOR: Record<string, string> = {
		hokkaido: '#4338ca',
		sakhalin: '#059669',
		kuril: '#d97706',
		other: '#78716c'
	};

	// #rrggbb → rgba() with alpha. Transparency must live in the fill color, NOT
	// element opacity: MapLibre's Marker rewrites element.style.opacity to 1 on
	// every render (its terrain occlusion feature), which would force opaque pins.
	function rgba(hex: string, a: number): string {
		const n = parseInt(hex.replace('#', ''), 16);
		return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
	}

	// Circular marker element; radius scales with how many sources sit at the place.
	// Translucent fill + solid stroke, matching the old Leaflet circleMarker.
	function bubble(color: string, radius: number) {
		const d = document.createElement('div');
		const size = `${radius * 2}px`;
		d.style.width = size;
		d.style.height = size;
		d.style.borderRadius = '50%';
		d.style.background = rgba(color, 0.35);
		d.style.border = `1.5px solid ${color}`;
		d.style.boxSizing = 'border-box';
		d.style.cursor = 'pointer';
		return d;
	}

	// Popups are built from DOM nodes (textContent / href) — never an HTML string (XSS).
	function popupNode(name: string, href: string, count: number) {
		const div = document.createElement('div');
		div.style.fontFamily = 'var(--font-sans)';
		const a = document.createElement('a');
		a.href = href;
		a.style.fontWeight = '600';
		a.style.color = '#4338ca';
		a.textContent = name;
		const span = document.createElement('span');
		span.style.color = '#78716c';
		span.textContent = `${count} ${m.map_sources_here()}`;
		div.appendChild(a);
		div.appendChild(document.createElement('br'));
		div.appendChild(span);
		return div;
	}

	onMount(() => {
		let map: import('maplibre-gl').Map | undefined;
		let cancelled = false;
		(async () => {
			let maplibre: typeof import('maplibre-gl');
			try {
				maplibre = await import('maplibre-gl');
			} catch (e) {
				// Chunk failed to load (offline/network) — leave the map uninitialized.
				console.error('MapView: failed to load maplibre-gl', e);
				return;
			}
			if (cancelled || !el) return;
			map = new maplibre.Map({
				container: el,
				style: OSM_STYLE,
				center: [143.5, 45.5],
				zoom: 4,
				maxZoom: 12,
				attributionControl: { compact: true }
			});
			// Keep it a flat, Leaflet-style 2D map — no scroll-zoom, no rotate/pitch.
			map.scrollZoom.disable();
			map.dragRotate.disable();
			map.touchZoomRotate.disableRotation();
			map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');

			for (const p of places) {
				const color = REGION_COLOR[p.region ?? 'other'] ?? '#78716c';
				const radius = 6 + Math.min(22, Math.sqrt(p.sourceCount) * 3);
				const name = p.nameEn && p.nameEn !== p.name ? `${p.name} · ${p.nameEn}` : p.name;
				const href = localizeHref(`/places/${p.slug}`);
				const popup = new maplibre.Popup({ offset: radius, closeButton: false }).setDOMContent(
					popupNode(name, href, p.sourceCount)
				);
				new maplibre.Marker({ element: bubble(color, radius) })
					.setLngLat([p.lng, p.lat])
					.setPopup(popup)
					.addTo(map);
			}
		})();

		return () => {
			cancelled = true;
			map?.remove();
		};
	});
</script>

<div
	bind:this={el}
	class="z-0 w-full overflow-hidden rounded-xl border border-stone-200"
	style="height:{height}"
></div>
