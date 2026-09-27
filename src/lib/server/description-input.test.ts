import { expect, it } from 'vitest';
import { parseSourceForm } from './form';
import { detailToInput, pickSourceInput } from './write-api';
import type { SourceDetail } from '$lib/types';

it('accepts Japanese form descriptions and trims surrounding whitespace', () => {
	const fd = new FormData();
	for (const [key, value] of Object.entries({ title: '辞典', type: 'dictionary', category: 'primary', summaryJa: '  アイヌ語辞典。  ' })) fd.set(key, value);
	expect(parseSourceForm(fd).input?.summaryJa).toBe('アイヌ語辞典。');
});

it('keeps Japanese text during unrelated PATCH edits and accepts explicit clearing', () => {
	const detail = { source: { title: '辞典', summary: 'A dictionary.', summaryJa: 'アイヌ語辞典。' }, links: [], tags: [] } as unknown as SourceDetail;
	const merged = { ...detailToInput(detail), ...pickSourceInput({ title: '改訂辞典' }) };
	expect(merged.summaryJa).toBe('アイヌ語辞典。');
	expect(pickSourceInput({ summaryJa: '日本語の概要。' })).toEqual({ summaryJa: '日本語の概要。' });
	expect(pickSourceInput({ summaryJa: '' })).toEqual({ summaryJa: '' });
	expect(pickSourceInput({ summaryJa: { ja: 'invalid shape' } })).toEqual({});
});
