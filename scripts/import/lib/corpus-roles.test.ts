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

it('treats the credited writers of written works as authors', () => {
	expect(corpusContributorRole('CDエクスプレス アイヌ語', '中本 ムツ子')).toBe('author');
	expect(corpusContributorRole('ニューエクスプレス・スペシャル 日本語の隣人たち I+II', '北原 モコットゥナㇱ')).toBe('author');
	expect(corpusContributorRole('エンチウ（樺太アイヌ語）会話入門', '村崎 恭子')).toBe('author');
	expect(corpusContributorRole('アイヌ民譚集', '知里 真志保')).toBe('author');
	expect(corpusContributorRole('アイヌ神謡集', '知里 幸恵')).toBe('author');
	expect(corpusContributorRole('知里幸恵のウウェペケレ（昔話）', '知里 幸恵')).toBe('author');
	expect(corpusContributorRole('千徳太郎治のピウスツキ宛書簡', '千徳 太郎治')).toBe('author');
	expect(corpusContributorRole('鍋沢元蔵筆録ノート', '鍋沢 元蔵')).toBe('author');
});

it('does not make a person-wide judgment about writing roles', () => {
	expect(corpusContributorRole('別の録音資料', '中川 裕')).toBe('speaker');
	expect(corpusContributorRole('CDエクスプレス アイヌ語', '川上 まつ子')).toBe('speaker');
	expect(corpusContributorRole('アイヌ神謡集', '知里 真志保')).toBe('speaker');
});

it('keeps narrators of recorded speech as speakers', () => {
	expect(corpusContributorRole('浅井タケ昔話全集 I, II', '浅井 タケ')).toBe('speaker');
	expect(corpusContributorRole('アイヌ口承文芸テキスト集', '白沢 ナベ')).toBe('speaker');
	expect(corpusContributorRole('アイヌの知恵・ウパシクマ1', '中本 ムツ子')).toBe('speaker');
	expect(corpusContributorRole('長濱清蔵のアイヌ語', '長濱 清蔵')).toBe('speaker');
});
