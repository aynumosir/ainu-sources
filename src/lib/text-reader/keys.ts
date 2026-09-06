/**
 * Document keys of the corpus text reader. A key is the corpus sentence-id
 * prefix before '#': `aa-asai/001`, `bible/1co/001`. Its first segment names
 * the collection, its last the document; anything between is a section
 * (the book, for the Bible).
 */

/** Sentences per reader page; longer documents are read in parts. */
export const READER_PAGE_SIZE = 400;

export function keySegments(key: string): string[] {
	return key.split('/').filter((s) => s.length > 0);
}

/** The section a document sits in, e.g. `1co` for `bible/1co/001`; empty when the key has none. */
export function documentSection(key: string): string {
	const segments = keySegments(key);
	return segments.length > 2 ? segments.slice(1, -1).join('/') : '';
}

/** The document's title, or its key's last segment when the corpus recorded none. */
export function documentLabel(doc: { key: string; title: string | null }): string {
	const title = doc.title?.trim();
	if (title) return title;
	return keySegments(doc.key).at(-1) ?? doc.key;
}

/** Bare (unlocalised) path of the contents page, a document, or one part of it. */
export function readerHref(slug: string, key?: string, page = 1): string {
	const base = `/sources/${slug}/read`;
	if (!key) return base;
	const path = `${base}/${keySegments(key).map(encodeURIComponent).join('/')}`;
	return page > 1 ? `${path}?page=${page}` : path;
}

export function pageCountOf(total: number, limit: number = READER_PAGE_SIZE): number {
	return Math.max(1, Math.ceil(total / limit));
}

/** Consecutive documents sharing a section, in reading order. */
export function groupBySection<T extends { key: string }>(docs: T[]): { section: string; docs: T[] }[] {
	const groups: { section: string; docs: T[] }[] = [];
	for (const doc of docs) {
		const section = documentSection(doc.key);
		const last = groups.at(-1);
		if (last && last.section === section) last.docs.push(doc);
		else groups.push({ section, docs: [doc] });
	}
	return groups;
}
