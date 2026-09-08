import { describe, expect, it } from 'vitest';
import { filterPlaces, hasCoordinates, placeRegion, type BrowsePlace } from './place-view';

const place = (slug: string, fields: Partial<BrowsePlace> = {}): BrowsePlace => ({
	id: slug, slug, name: slug, nameEn: null, nameAin: null,
	region: null, kind: 'region', lat: null, lng: null, sourceCount: 0,
	...fields
});
const places = [
	place('hokkaido', { name: '北海道', nameEn: 'Hokkaidō', nameAin: 'Yaunmosir', region: 'hokkaido', lat: 43, lng: 142 }),
	place('sakhalin', { name: '樺太', nameAin: 'Repunmosir', region: 'sakhalin', lat: 50, lng: 143 }),
	place('proto-ainu', { region: 'proto' }),
	place('multiple', { region: 'other' }),
	place('unknown', { region: 'unrecognized' })
];

describe('place browsing', () => {
	it.each(['北海道', ' HOKKAIDO ', 'Yaunmosir', 'hokkaido 北海道'])('finds names across scripts: %s', (query) => {
		expect(filterPlaces(places, query, '').map((p) => p.slug)).toEqual(['hokkaido']);
	});
	it('applies search and region together to the list and map', () => {
		expect(filterPlaces(places, 'mosir', 'sakhalin').map((p) => p.slug)).toEqual(['sakhalin']);
		expect(filterPlaces(places, 'Hokkaido', 'sakhalin')).toEqual([]);
	});
	it('keeps unmapped places browsable and separates other from unassigned regions', () => {
		const all = filterPlaces(places, ' ', '');
		expect(all).toHaveLength(5);
		expect(all.filter(hasCoordinates).map((p) => p.slug)).toEqual(['hokkaido', 'sakhalin']);
		expect(filterPlaces(places, '', 'proto').map((p) => p.slug)).toEqual(['proto-ainu']);
		expect(filterPlaces(places, '', 'other').map((p) => p.slug)).toEqual(['multiple']);
		expect(filterPlaces(places, '', 'unassigned').map((p) => p.slug)).toEqual(['unknown']);
		expect(placeRegion(place('unset'))).toBe('unassigned');
	});
	it('accepts zero coordinates and excludes incomplete pairs', () => {
		expect(hasCoordinates(place('origin', { lat: 0, lng: 0 }))).toBe(true);
		expect(hasCoordinates(place('latitude-only', { lat: 43 }))).toBe(false);
		expect(hasCoordinates(place('longitude-only', { lng: 142 }))).toBe(false);
	});
});
