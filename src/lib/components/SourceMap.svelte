<script lang="ts">
	import { onMount } from 'svelte';
	import 'leaflet/dist/leaflet.css';
	import type { PlaceRef } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { tl, PLACE_ROLE_LABELS, PLACE_ROLE_COLOR } from '$lib/constants';

	let { places, height = '260px' }: { places: PlaceRef[]; height?: string } = $props();

	// Only geo-located places can be pinned.
	const pins = $derived(places.filter((p) => p.lat != null && p.lng != null));
	// Distinct roles present, for the legend.
	const legend = $derived([...new Set(pins.map((p) => p.role))]);

	let el = $state<HTMLDivElement>();
	let L = $state<typeof import('leaflet') | null>(null);
	let map = $state<import('leaflet').Map | null>(null);
	let markers: import('leaflet').LayerGroup | null = null;

	// Build a popup as DOM nodes (textContent), never an HTML string — name/role/href
	// are data-derived and must not be interpolated into markup (XSS).
	function popup(name: string, role: string, href: string, color: string) {
		const div = document.createElement('div');
		div.style.fontFamily = 'var(--font-sans)';
		const a = document.createElement('a');
		a.href = href;
		a.style.fontWeight = '600';
		a.style.color = color;
		a.textContent = name;
		const span = document.createElement('span');
		span.style.color = '#78716c';
		span.textContent = role;
		div.appendChild(a);
		div.appendChild(document.createElement('br'));
		div.appendChild(span);
		return div;
	}

	onMount(() => {
		let cancelled = false;
		(async () => {
			const mod = await import('leaflet');
			if (cancelled || !el) return;
			const m = mod.map(el, { scrollWheelZoom: false });
			mod.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				attribution: '&copy; OpenStreetMap contributors',
				maxZoom: 12
			}).addTo(m);
			markers = mod.layerGroup().addTo(m);
			L = mod;
			map = m;
		})();

		return () => {
			cancelled = true;
			map?.remove();
			map = null;
			markers = null;
		};
	});

	// Re-render markers whenever the place set changes — otherwise client-side
	// navigation to another source would leave the previous source's pins behind.
	$effect(() => {
		if (!L || !map || !markers) return;
		markers.clearLayers();
		const latlngs: [number, number][] = [];
		for (const p of pins) {
			const color = PLACE_ROLE_COLOR[p.role] ?? '#78716c';
			const name = p.nameEn && p.nameEn !== p.name ? `${p.name} · ${p.nameEn}` : p.name;
			const role = tl(PLACE_ROLE_LABELS, p.role);
			const href = localizeHref(`/places/${p.slug}`);
			latlngs.push([p.lat!, p.lng!]);
			L.circleMarker([p.lat!, p.lng!], {
				radius: 8,
				color,
				weight: 2,
				fillColor: color,
				fillOpacity: 0.4
			})
				.addTo(markers)
				.bindPopup(popup(name, role, href, color));
		}
		if (latlngs.length === 1) map.setView(latlngs[0], 6);
		else if (latlngs.length) map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
	});
</script>

{#if pins.length}
	<div
		bind:this={el}
		class="z-0 w-full overflow-hidden rounded-lg border border-stone-200"
		style="height:{height}"
	></div>
	<div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
		{#each legend as role (role)}
			<span class="flex items-center gap-1.5 text-xs text-stone-500">
				<span
					class="inline-block size-2.5 rounded-full"
					style="background:{PLACE_ROLE_COLOR[role] ?? '#78716c'}"
				></span>
				{tl(PLACE_ROLE_LABELS, role)}
			</span>
		{/each}
	</div>
{/if}
