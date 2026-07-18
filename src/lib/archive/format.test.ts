import { describe, expect, it } from 'vitest';
import { formatBytes, middleEllipsis } from './format';

describe('formatBytes', () => {
	it('formats byte counts using decimal units', () => {
		expect(formatBytes(662_000_000)).toBe('662 MB');
		expect(formatBytes(1_250)).toBe('1.3 KB');
		expect(formatBytes(12_500)).toBe('13 KB');
		expect(formatBytes(999)).toBe('999 B');
	});

	it('handles missing and negative values', () => {
		expect(formatBytes(null)).toBe('unknown size');
		expect(formatBytes(-1_500)).toBe('-1.5 KB');
	});
});

describe('middleEllipsis', () => {
	it('shortens long values and keeps the full ends', () => {
		expect(middleEllipsis('0123456789abcdef', 4, 4)).toBe('0123...cdef');
	});

	it('keeps short values unchanged', () => {
		expect(middleEllipsis('abcdef', 4, 4)).toBe('abcdef');
	});
});
