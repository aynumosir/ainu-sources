import { catalogueSlugResolver } from './catalogue-slugs';

export interface RecordUnit {
	slug: string;
	label: string;
	catalogue: string | null;
	title: string | null;
	holder: string;
	holderEn: string;
	shelfmark: string | null;
	pages: number;
	items: number;
}
export interface EarlyRecord {
	slug: string;
	catalogue: string;
	title: string;
	titleLatin: string;
	kind: string;
	units: RecordUnit[];
}

/** Fail closed before replacing the checked-in snapshot if either contract changes. */
export function projectRecordsIndex(input: unknown, catalogue: unknown): { sources: EarlyRecord[] } {
	const object = (v: unknown): Record<string, unknown> => {
		if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
		return v as Record<string, unknown>;
	};
	const str = (v: unknown): string => {
		if (typeof v !== 'string') throw new Error('Expected string');
		return v;
	};
	const nullable = (v: unknown) => v == null ? null : str(v);
	const slug = (v: unknown) => {
		const s = str(v);
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)) throw new Error(`Invalid slug: ${s}`);
		return s;
	};
	const count = (v: unknown) => {
		if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error('Invalid count');
		return v;
	};
	const resolve = catalogueSlugResolver(catalogue);
	const sources = object(input).sources;
	if (!Array.isArray(sources) || !sources.length) throw new Error('Expected nonempty sources');
	const seen = new Set<string>();
	return { sources: sources.map((value) => {
		const s = object(value);
		const name = slug(s.slug);
		if (seen.has(name)) throw new Error(`Duplicate source: ${name}`);
		seen.add(name);
		if (!Array.isArray(s.units) || !s.units.length) throw new Error('Expected nonempty units');
		const units = new Set<string>();
		return {
			slug: name, catalogue: resolve(s.catalogue), title: str(s.title), titleLatin: str(s.titleLatin), kind: str(s.kind),
			units: s.units.map((value) => {
				const u = object(value), w = object(u.witness), name = slug(u.slug);
				if (units.has(name)) throw new Error(`Duplicate unit: ${name}`);
				units.add(name);
				return { slug: name, label: str(u.label), catalogue: w.catalogue == null ? null : resolve(w.catalogue),
					title: nullable(w.title), holder: str(w.holder), holderEn: str(w.holderEn), shelfmark: nullable(w.shelfmark),
					pages: count(u.pages), items: count(u.items) };
			})
		};
	}) };
}
