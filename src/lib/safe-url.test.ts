import { describe, it, expect } from 'vitest';
import { safeUrl } from './safe-url';

describe('safeUrl', () => {
	describe('accepts http(s) URLs', () => {
		it('returns the cleaned http URL', () => {
			expect(safeUrl('http://example.com')).toBe('http://example.com');
		});

		it('returns the cleaned https URL', () => {
			expect(safeUrl('https://example.com/path?q=1#frag')).toBe(
				'https://example.com/path?q=1#frag'
			);
		});

		it('trims surrounding whitespace', () => {
			expect(safeUrl('  https://example.com  ')).toBe('https://example.com');
		});

		it('strips control characters from an otherwise-valid http URL', () => {
			// The cleaner removes ASCII control chars before validating; an
			// embedded newline in the host portion is dropped, leaving a valid URL.
			expect(safeUrl('https://exa\nmple.com')).toBe('https://example.com');
		});

		it('is case-insensitive on the http scheme', () => {
			expect(safeUrl('HTTPS://example.com')).toBe('HTTPS://example.com');
		});
	});

	describe('rejects dangerous schemes (returns null)', () => {
		it('rejects javascript:', () => {
			expect(safeUrl('javascript:alert(1)')).toBeNull();
		});

		it('rejects JavaScript: (mixed case)', () => {
			expect(safeUrl('JavaScript:alert(1)')).toBeNull();
		});

		it('rejects java\\tscript: (TAB obfuscation)', () => {
			expect(safeUrl('java\tscript:alert(1)')).toBeNull();
		});

		it('rejects java\\nscript: (newline obfuscation)', () => {
			expect(safeUrl('java\nscript:alert(1)')).toBeNull();
		});

		it('rejects a carriage-return obfuscated javascript scheme', () => {
			expect(safeUrl('java\rscript:alert(1)')).toBeNull();
		});

		it('rejects data: URLs', () => {
			expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
		});

		it('rejects vbscript:', () => {
			expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
		});

		it('rejects mailto:', () => {
			expect(safeUrl('mailto:someone@example.com')).toBeNull();
		});
	});

	describe('rejects non-absolute / malformed / empty input (returns null)', () => {
		it('rejects a relative path', () => {
			expect(safeUrl('/foo')).toBeNull();
		});

		it('rejects a malformed value that is not a URL', () => {
			expect(safeUrl('not a url')).toBeNull();
		});

		it('rejects the empty string', () => {
			expect(safeUrl('')).toBeNull();
		});

		it('rejects a whitespace-only string', () => {
			expect(safeUrl('   ')).toBeNull();
		});

		it('rejects a control-char-only string (cleans to empty)', () => {
			expect(safeUrl('\t')).toBeNull();
		});

		it('rejects null', () => {
			expect(safeUrl(null)).toBeNull();
		});

		it('rejects undefined', () => {
			expect(safeUrl(undefined)).toBeNull();
		});
	});
});
