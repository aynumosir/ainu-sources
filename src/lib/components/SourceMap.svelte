<script lang="ts">
	import { onMount } from 'svelte';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import type { PlaceRef } from '$lib/types';
	import { localizeHref } from '$lib/paraglide/runtime';
	import { tl, PLACE_ROLE_LABELS, PLACE_ROLE_COLOR } from '$lib/constants';
	import { OSM_STYLE } from '$lib/map-style';

	let { places, height = '260px' }: { places: PlaceRef[]; height?: string } = $props();

	// Only geo-located places can be pinned.
	const pins = $derived(places.filter((p) => p.lat != null && p.lng != null));
	// Distinct roles present, for the legend.
	const legend = $derived([...new Set(pins.map((p) => p.role))]);

	let el = $state<HTMLDivElement>();
	let lib = $state<typeof import('maplibre-gl') | null>(null);
	let map = $state<import('maplibre-gl').Map | null>(null);
	let markers: import('maplibre-gl').Marker[] = [];

	function dot(color: string) {
		const d = document.createElement('div');
		d.style.width = '16px';
		d.style.height = '16px';
		d.style.borderRadius = '50%';
		d.style.background = color;
		d.style.opacity = '0.5';
		d.style.border = `2px solid ${color}`;
		d.style.cursor = 'pointer';
		return d;
	}

	// Popup built from DOM nodes (textContent / href) — never an HTML string (XSS).
	function popupNode(name: string, role: string, href: string, color: string) {
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
			let maplibre: typeof import('maplibre-gl');
			try {
				maplibre = await import('maplibre-gl');
			} catch (e) {
				// Chunk failed to load (offline/network) — leave the map uninitialized.
				console.error('SourceMap: failed to load maplibre-gl', e);
				return;
			}
			if (cancelled || !el) return;
			const mp = new maplibre.Map({
				container: el,
				style: OSM_STYLE,
				center: [142, 44],
				zoom: 4,
				attributionControl: { compact: true }
			});
			mp.scrollZoom.disable();
			lib = maplibre;
			map = mp;
		})();

		return () => {
			cancelled = true;
			for (const mk of markers) mk.remove();
			markers = [];
			map?.remove();
			map = null;
			lib = null;
		};
	});

	// Re-render pins whenever the place set changes — otherwise client-side
	// navigation to another source would leave the previous source's pins behind.
	$effect(() => {
		if (!lib || !map) return;
		const L = lib;
		const mp = map;
		for (const mk of markers) mk.remove();
		markers = [];
		const bounds = new L.LngLatBounds();
		for (const p of pins) {
			const color = PLACE_ROLE_COLOR[p.role] ?? '#78716c';
			const name = p.nameEn && p.nameEn !== p.name ? `${p.name} · ${p.nameEn}` : p.name;
			const role = tl(PLACE_ROLE_LABELS, p.role);
			const href = localizeHref(`/places/${p.slug}`);
			const popup = new L.Popup({ offset: 10, closeButton: false }).setDOMContent(
				popupNode(name, role, href, color)
			);
			const mk = new L.Marker({ element: dot(color) })
				.setLngLat([p.lng!, p.lat!])
				.setPopup(popup)
				.addTo(mp);
			markers.push(mk);
			bounds.extend([p.lng!, p.lat!]);
		}
		if (pins.length === 1) mp.jumpTo({ center: [pins[0].lng!, pins[0].lat!], zoom: 6 });
		else if (pins.length) mp.fitBounds(bounds, { padding: 40, maxZoom: 8, duration: 0 });
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
