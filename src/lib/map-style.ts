import type { StyleSpecification } from 'maplibre-gl';

// Free OpenStreetMap raster basemap — no API key, same tiles the app used with
// Leaflet. (Low-volume scholarly site, within OSM's tile usage policy.)
// A type-only import keeps maplibre-gl out of this module's runtime/SSR graph.
export const OSM_STYLE: StyleSpecification = {
	version: 8,
	sources: {
		osm: {
			type: 'raster',
			tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
			tileSize: 256,
			attribution: '&copy; OpenStreetMap contributors',
			maxzoom: 19
		}
	},
	layers: [
		// Parchment backdrop shows through while tiles load (matches the old map bg).
		{ id: 'bg', type: 'background', paint: { 'background-color': '#e6ddc6' } },
		{ id: 'osm', type: 'raster', source: 'osm' }
	]
};
