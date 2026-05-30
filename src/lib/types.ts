import type {
	Source,
	SourceLink,
	Person,
	Place,
	Institution,
	Tag,
	SourceRelation
} from '$lib/server/db/schema';

export type SortKey =
	| 'year-asc'
	| 'year-desc'
	| 'title'
	| 'updated'
	| 'entries-desc';

export interface SourceFilters {
	q?: string;
	category?: string;
	types?: string[];
	regions?: string[];
	languages?: string[];
	scripts?: string[];
	centuries?: number[]; // e.g. [17, 18, 19]
	tag?: string; // tag slug
	person?: string; // person slug
	hasDigital?: boolean;
	sort?: SortKey;
	page?: number;
	pageSize?: number;
}

export interface FacetBucket {
	key: string;
	count: number;
}

export interface Facets {
	categories: FacetBucket[];
	types: FacetBucket[];
	regions: FacetBucket[];
	languages: FacetBucket[];
	scripts: FacetBucket[];
	centuries: FacetBucket[]; // key = century number as string
}

export interface SourceListResult {
	items: Source[];
	total: number;
	page: number;
	pageSize: number;
	pageCount: number;
}

export interface PersonRef extends Person {
	role: string;
}
export interface PlaceRef extends Place {
	role: string;
}
export interface InstitutionRef extends Institution {
	role: string;
	callNumber: string | null;
}
export interface RelatedSource {
	relation: SourceRelation;
	source: Source;
	direction: 'out' | 'in';
}

/** A source with all its joined detail, for the detail page. */
export interface SourceDetail {
	source: Source;
	links: SourceLink[];
	persons: PersonRef[];
	places: PlaceRef[];
	institutions: InstitutionRef[];
	tags: Tag[];
	related: RelatedSource[];
	revisionCount: number;
}

export interface DbStats {
	total: number;
	byCategory: FacetBucket[];
	byRegion: FacetBucket[];
	byType: FacetBucket[];
	personCount: number;
	placeCount: number;
	institutionCount: number;
	yearMin: number | null;
	yearMax: number | null;
	withDigital: number;
}

export interface TimelinePoint {
	slug: string;
	title: string;
	titleEn: string | null;
	yearStart: number;
	yearEnd: number | null;
	yearCertainty: string | null;
	category: string;
	type: string;
	region: string | null;
}

export interface MapPlace {
	id: string;
	slug: string;
	name: string;
	nameEn: string | null;
	region: string | null;
	kind: string;
	lat: number;
	lng: number;
	sourceCount: number;
}
