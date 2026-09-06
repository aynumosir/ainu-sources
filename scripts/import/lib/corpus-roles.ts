import { canonicalSlugFor } from './derive';

// The corpus author field mixes writers with narrators, so it cannot establish
// a role on its own: only reviewed (collection, contributor) pairs claim an
// author credit, and every other credit stays a speaking role. Evidence is
// recorded in scripts/data/person-attribution-review.json.
// A pair lists the canonical person slug when the alias table resolves the
// name, and the space-stripped name otherwise.
const WRITTEN_CREDITS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['ニューエクスプレスプラス アイヌ語', new Set(['nakagawa-hiroshi'])],
	['カムイユカㇻを聞いてアイヌ語を学ぶ', new Set(['nakagawa-hiroshi'])],
	['CDエクスプレス アイヌ語', new Set(['中本ムツ子'])],
	['ニューエクスプレス・スペシャル 日本語の隣人たち I+II', new Set(['mokottunas-kitahara'])],
	['エンチウ（樺太アイヌ語）会話入門', new Set(['murasaki-kyoko'])],
	['アイヌ民譚集', new Set(['chiri-mashiho'])],
	['アイヌ神謡集', new Set(['chiri-yukie'])],
	['知里幸恵のウウェペケレ（昔話）', new Set(['chiri-yukie'])],
	['千徳太郎治のピウスツキ宛書簡', new Set(['千徳太郎治'])],
	['鍋沢元蔵筆録ノート', new Set(['鍋沢元蔵'])]
]);

export function corpusContributorRole(collection: string, name: string): 'author' | 'speaker' {
	const written = WRITTEN_CREDITS.get(collection);
	if (!written) return 'speaker';
	const slug = canonicalSlugFor(name);
	return slug !== null && written.has(slug) || written.has(name.replace(/\s+/g, ''))
		? 'author'
		: 'speaker';
}
