/** Resolve public catalogue identities through renames and merges. */
export function catalogueSlugResolver(catalogue: unknown): (value: unknown) => string {
	const object = (v: unknown): Record<string, unknown> => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
		return v as Record<string, unknown>;
	};
	const str = (v: unknown): string => {
		if (typeof v !== 'string') throw new Error('Expected string');
		return v;
	};
	const slug = (v: unknown) => {
		const s = str(v);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) throw new Error(`Invalid slug: ${s}`);
		return s;
	};
	if (!Array.isArray(catalogue)) throw new Error('Expected catalogue array');
	const aliases = new Map<string, string>();
	const terminals = new Set<string>();
	const setAlias = (name: string, target: string) => {
		if (aliases.has(name)) throw new Error(`Duplicate catalogue identity: ${name}`);
		aliases.set(name, target);
	};
	for (const value of catalogue) {
		const row = object(value);
		if (!['active', 'deprecated', 'merged'].includes(str(row.status))) continue;
		const name = slug(row.slug);
		const target = row.status === 'merged' ? slug(row.merged_into_slug) : name;
		setAlias(name, target);
		if (row.status !== 'merged') terminals.add(name);
		if (!Array.isArray(row.old_slugs)) throw new Error('Expected old_slugs');
		for (const old of row.old_slugs) setAlias(slug(old), target);
	}
	const resolve = (v: unknown) => {
		const name = slug(v);
		const visited = new Set<string>();
		let current = name;
		while (!visited.has(current)) {
			visited.add(current);
			const target = aliases.get(current);
			if (!target) throw new Error(`Unresolved catalogue slug: ${name}`);
			if (target === current && terminals.has(current)) return current;
			current = target;
		}
		throw new Error(`Catalogue redirect cycle: ${name}`);
	};
	return resolve;
}
