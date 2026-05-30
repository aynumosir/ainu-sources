<script lang="ts">
	import { onMount } from 'svelte';
	import 'leaflet/dist/leaflet.css';
	import type { MapPlace } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { m } from '$lib/paraglide/messages.js';

	let { places, height = '70vh' }: { places: MapPlace[]; height?: string } = $props();

	let el: HTMLDivElement;

	const REGION_COLOR: Record<string, string> = {
		hokkaido: '#4338ca',
		sakhalin: '#059669',
		kuril: '#d97706',
		other: '#78716c'
	};

	onMount(() => {
		let map: import('leaflet').Map | undefined;
		let cancelled = false;
		(async () => {
			const L = await import('leaflet');
			if (cancelled || !el) return;
			map = L.map(el, { scrollWheelZoom: false }).setView([45.5, 143.5], 4);
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				attribution: '&copy; OpenStreetMap contributors',
				maxZoom: 12
			}).addTo(map);

			for (const p of places) {
				const color = REGION_COLOR[p.region ?? 'other'] ?? '#78716c';
				const r = 6 + Math.min(22, Math.sqrt(p.sourceCount) * 3);
				const name = p.nameEn && p.nameEn !== p.name ? `${p.name} · ${p.nameEn}` : p.name;
				const href = localizeHref(`/places/${p.slug}`);
				L.circleMarker([p.lat, p.lng], {
					radius: r,
					color,
					weight: 1.5,
					fillColor: color,
					fillOpacity: 0.35
				})
					.addTo(map)
					.bindPopup(
						`<div style="font-family:var(--font-sans)"><a href="${href}" style="font-weight:600;color:#4338ca">${name}</a><br><span style="color:#78716c">${p.sourceCount} ${m.map_sources_here()}</span></div>`
					);
			}
		})();

		return () => {
			cancelled = true;
			map?.remove();
		};
	});
</script>

<div bind:this={el} class="z-0 w-full overflow-hidden rounded-xl border border-stone-200" style="height:{height}"></div>
