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

	let el: HTMLDivElement;

	onMount(() => {
		let map: import('leaflet').Map | undefined;
		let cancelled = false;
		(async () => {
			const L = await import('leaflet');
			if (cancelled || !el || !pins.length) return;
			map = L.map(el, { scrollWheelZoom: false });
			L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				attribution: '&copy; OpenStreetMap contributors',
				maxZoom: 12
			}).addTo(map);

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
					.addTo(map)
					.bindPopup(
						`<div style="font-family:var(--font-sans)"><a href="${href}" style="font-weight:600;color:${color}">${name}</a><br><span style="color:#78716c">${role}</span></div>`
					);
			}
			if (latlngs.length === 1) map.setView(latlngs[0], 6);
			else map.fitBounds(L.latLngBounds(latlngs).pad(0.3));
		})();

		return () => {
			cancelled = true;
			map?.remove();
		};
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
