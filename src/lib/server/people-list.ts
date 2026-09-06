import {
	listPersons,
	countPersons,
	PERSON_PAGE_SIZE,
	PERSON_MAX_OFFSET,
	type PersonListOptions,
	type PersonWithCount
} from './queries';
import { personRole } from '$lib/person-roles';

const SORTS = ['count', 'name', 'name-desc'] as const;
export type PersonSort = (typeof SORTS)[number];

export interface PeopleQuery {
	q: string;
	role: string;
	sort: PersonSort;
	offset: number;
}

export interface PeopleChunk {
	items: PersonWithCount[];
	total: number;
	offset: number;
	limit: number;
	hasMore: boolean;
}

/** Reads the /people search params; `undefined` when the offset is out of range. */
export function parsePeopleQuery(sp: URLSearchParams): PeopleQuery | undefined {
	const sortParam = sp.get('sort');
	const offsetParam = sp.get('offset');
	const offset = offsetParam ? Number(offsetParam) : 0;
	if (!Number.isInteger(offset) || offset < 0 || offset > PERSON_MAX_OFFSET) return undefined;
	const role = sp.get('role');
	return {
		q: sp.get('q') ?? '',
		role: role ? personRole(role) : '',
		sort: SORTS.includes(sortParam as PersonSort) ? (sortParam as PersonSort) : 'count',
		offset
	};
}

export async function loadPeopleChunk(query: PeopleQuery): Promise<PeopleChunk> {
	const opts: PersonListOptions = {
		q: query.q || undefined,
		role: query.role || undefined,
		sort: query.sort,
		offset: query.offset,
		limit: PERSON_PAGE_SIZE
	};
	const [items, total] = await Promise.all([listPersons(opts), countPersons(opts)]);
	return {
		items,
		total,
		offset: query.offset,
		limit: PERSON_PAGE_SIZE,
		hasMore: query.offset + items.length < total
	};
}
