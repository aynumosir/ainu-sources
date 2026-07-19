import { describe, expect, it } from 'vitest';
import { archiveLabels } from './bilingual-labels';

describe('archiveLabels', () => {
	it('defines non-empty Japanese and English text for every label', () => {
		for (const [key, entry] of Object.entries(archiveLabels)) {
			expect(entry.ja.trim(), `${key}.ja`).not.toHaveLength(0);
			expect(entry.en.trim(), `${key}.en`).not.toHaveLength(0);
		}
	});
});
