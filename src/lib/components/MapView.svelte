<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { MapPlace } from '$lib/types';
	import { getLocale, localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';
	import { OSM_STYLE } from '$lib/map-style';

	let { places, height = '70vh' }: { places: MapPlace[]; height?: string } = $props();

	let el = $state<HTMLDivElement>();
	let ready = $state.raw<{ map: import('maplibre-gl').Map; library: typeof import('maplibre-gl') }>();
	let failed = $state(false);
	let bounds: import('maplibre-gl').LngLatBounds | undefined;
	let pendingFit = true;

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
		d.className = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700';
		const size = `${radius * 2}px`;
		d.style.width = size;
		d.style.height = size;
		d.style.borderRadius = '50%';
		d.style.background = rgba(color, 0.35);
		d.style.border = `1.5px solid ${color}`;
		d.style.boxSizing = 'border-box';
		d.style.padding = '0';
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

	function fitMap(map: import('maplibre-gl').Map) {
		if (!el?.clientWidth || !el.clientHeight) return;
		map.resize();
		if (pendingFit && bounds && !bounds.isEmpty()) {
			map.fitBounds(bounds, { padding: 48, maxZoom: 8, duration: 0 });
			pendingFit = false;
		}
	}

	onMount(() => {
		let map: import('maplibre-gl').Map | undefined;
		let observer: ResizeObserver | undefined;
		let cancelled = false;
		(async () => {
			try {
				const library = await import('maplibre-gl');
				if (cancelled || !el) return;
				map = new library.Map({
					container: el,
					style: OSM_STYLE,
					center: [143.5, 45.5],
					zoom: 4,
					maxZoom: 12,
					cooperativeGestures: true,
					attributionControl: { compact: true }
				});
				map.dragRotate.disable();
				map.touchZoomRotate.disableRotation();
				map.addControl(new library.NavigationControl({ showCompass: false }), 'top-right');
				const currentMap = map;
				observer = new ResizeObserver(() => {
					if (!el?.clientWidth || !el.clientHeight) {
						pendingFit = true;
						return;
					}
					fitMap(currentMap);
				});
				observer.observe(el);
				ready = { map, library };
			} catch {
				if (!cancelled) failed = true;
			}
		})();
		return () => {
			cancelled = true;
			observer?.disconnect();
			map?.remove();
		};
	});

	$effect(() => {
		if (!ready) return;
		const { map, library } = ready;
		const locale = getLocale();
		bounds = new library.LngLatBounds();
		pendingFit = true;
		const markers = places.map((p) => {
			const color = REGION_COLOR[p.region ?? 'other'] ?? '#78716c';
			const radius = 6 + Math.min(22, Math.sqrt(p.sourceCount) * 3);
			const name = p.nameEn && p.nameEn !== p.name ? `${p.name} · ${p.nameEn}` : p.name;
			const href = localizeHref(`/places/${p.slug}`, { locale });
			const popup = new library.Popup({ offset: radius, closeButton: false }).setDOMContent(
				popupNode(name, href, p.sourceCount)
			);
			const element = bubble(color, radius);
			element.setAttribute('aria-label', `${name}: ${p.sourceCount} ${m.map_sources_here()}`);
			bounds!.extend([p.lng, p.lat]);
			return new library.Marker({ element })
				.setLngLat([p.lng, p.lat])
				.setPopup(popup)
				.addTo(map);
		});
		fitMap(map);
		return () => {
			for (const marker of markers) {
				marker.getPopup()?.remove();
				marker.remove();
			}
		};
	});
</script>

{#if failed}
	<p role="status" class="rounded-xl border border-stone-200 p-6 text-sm text-stone-500">{m.places_map_error()}</p>
{/if}
<div
	bind:this={el}
	class:hidden={failed}
	class="z-0 w-full overflow-hidden rounded-xl border border-stone-200"
	style="height:{height}"
></div>
