import { canonicalSlugFor } from './derive';

// These textbooks credit Nakagawa as their author. The corpus author field
// mixes textbook authors with narrators, so it cannot establish a speaking role.
// Evidence is recorded in scripts/data/person-attribution-review.json.
const TEXTBOOKS = new Set([
	'ニューエクスプレスプラス アイヌ語',
	'カムイユカㇻを聞いてアイヌ語を学ぶ'
]);

export function corpusContributorRole(collection: string, name: string): 'author' | 'speaker' {
	if (TEXTBOOKS.has(collection) && canonicalSlugFor(name) === 'nakagawa-hiroshi') return 'author';
	return 'speaker';
}
