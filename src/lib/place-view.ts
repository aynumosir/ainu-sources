import { REGION_ORDER } from './constants';
import type { MapPlace } from './types';

export type BrowsePlace = Omit<MapPlace, 'lat' | 'lng'> & {
	nameAin: string | null;
	lat: number | null;
	lng: number | null;
};

export function placeRegion(place: BrowsePlace): string {
	return place.region && REGION_ORDER.includes(place.region) ? place.region : 'unassigned';
}

function searchText(value: string): string {
	return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

export function filterPlaces<T extends BrowsePlace>(places: T[], query: string, region: string): T[] {
	const terms = searchText(query).trim().split(/\s+/u).filter(Boolean);
	return places.filter((place) => {
		if (region && placeRegion(place) !== region) return false;
		const text = searchText([place.name, place.nameEn, place.nameAin, place.slug].join(' '));
		return terms.every((term) => text.includes(term));
	});
}

export function hasCoordinates<T extends BrowsePlace>(place: T): place is T & MapPlace {
	return place.lat != null && place.lng != null;
}
