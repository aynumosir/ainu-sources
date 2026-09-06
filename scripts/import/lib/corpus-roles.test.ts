import { expect, it } from 'vitest';
import { corpusContributorRole } from './corpus-roles';

it('keeps textbook authors separate from the narrators in the same collections', () => {
	for (const title of ['ニューエクスプレスプラス アイヌ語', 'カムイユカㇻを聞いてアイヌ語を学ぶ']) {
		for (const name of ['中川 裕', '中川裕', 'Nakagawa Hiroshi']) {
			expect(corpusContributorRole(title, name)).toBe('author');
		}
	}
	expect(corpusContributorRole('ニューエクスプレスプラス アイヌ語', '川上 まつ子')).toBe('speaker');
	expect(corpusContributorRole('ニューエクスプレスプラス アイヌ語', '関根 健司')).toBe('speaker');
	expect(corpusContributorRole('カムイユカㇻを聞いてアイヌ語を学ぶ', '中本 ムツ子')).toBe('speaker');
});

it('does not make a person-wide judgment about speaking roles', () => {
	expect(corpusContributorRole('別の録音資料', '中川 裕')).toBe('speaker');
});
