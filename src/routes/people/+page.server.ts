import type { PageServerLoad } from './$types';
import { listPersons, listPersonRoles, type PersonListOptions } from '$lib/server/queries';

const SORTS = ['count', 'name', 'name-desc'] as const;

export const load: PageServerLoad = async ({ url }) => {
	const sp = url.searchParams;
	const sortParam = sp.get('sort');
	const opts: PersonListOptions = {
		q: sp.get('q') ?? undefined,
		role: sp.get('role') ?? undefined,
		sort: SORTS.includes(sortParam as never) ? (sortParam as PersonListOptions['sort']) : 'count'
	};
	const [people, roles] = await Promise.all([listPersons(opts), listPersonRoles()]);
	return { people, roles, filters: { q: opts.q ?? '', role: opts.role ?? '', sort: opts.sort } };
};
