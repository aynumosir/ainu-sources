import { describe, expect, it } from 'vitest';
import { archiveDisplayName, archiveRoleLabel } from './identity';

describe('archive identity labels', () => {
	it('prefers a profile name', () => {
		expect(archiveDisplayName('  Kayano Shigeru  ', 'kayano@example.test', 'archive_reader')).toBe(
			'Kayano Shigeru'
		);
	});

	it('uses the email local part when the profile name is empty', () => {
		expect(archiveDisplayName(' ', 'kayano@example.test', 'archive_reviewer')).toBe('kayano');
	});

	it('falls back to the role label without consulting an identity id', () => {
		expect(archiveDisplayName(null, null, 'archive_contributor')).toBe('Contributor');
		expect(archiveRoleLabel('archive_admin')).toBe('Administrator');
	});
});
