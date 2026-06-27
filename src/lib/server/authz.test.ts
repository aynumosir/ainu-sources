import { describe, it, expect, beforeEach } from 'vitest';
import { env } from '$env/dynamic/private';
import { roleOf, isAdmin, isModerator } from './authz';

// `env` is the shared object from the `$env/dynamic/private` test stub
// (test/stubs/env-dynamic-private.ts), aliased in vitest.config.ts. authz.ts
// reads it on every call, so mutating it here drives the allowlists.
beforeEach(() => {
	delete env.ADMIN_USER_IDS;
	delete env.MODERATOR_USER_IDS;
});

const user = (id: string) => ({ id });

describe('roleOf', () => {
	it('returns null for anonymous users', () => {
		expect(roleOf(null)).toBeNull();
		expect(roleOf(undefined)).toBeNull();
	});

	it('treats any signed-in user as an editor by default', () => {
		expect(roleOf(user('u1'))).toBe('editor');
	});

	it('promotes ids in MODERATOR_USER_IDS to moderator', () => {
		env.MODERATOR_USER_IDS = 'mod1, mod2';
		expect(roleOf(user('mod1'))).toBe('moderator');
		expect(roleOf(user('mod2'))).toBe('moderator');
		expect(roleOf(user('other'))).toBe('editor');
	});

	it('promotes ids in ADMIN_USER_IDS to admin', () => {
		env.ADMIN_USER_IDS = 'boss';
		expect(roleOf(user('boss'))).toBe('admin');
	});

	it('gives admin precedence over moderator when an id is in both lists', () => {
		env.ADMIN_USER_IDS = 'dual';
		env.MODERATOR_USER_IDS = 'dual';
		expect(roleOf(user('dual'))).toBe('admin');
	});

	it('parses allowlists separated by commas and/or whitespace', () => {
		env.ADMIN_USER_IDS = '  a,b   c\nd ';
		for (const id of ['a', 'b', 'c', 'd']) {
			expect(roleOf(user(id))).toBe('admin');
		}
		expect(roleOf(user('e'))).toBe('editor');
	});
});

describe('isAdmin', () => {
	it('is true only for admin ids', () => {
		env.ADMIN_USER_IDS = 'boss';
		expect(isAdmin(user('boss'))).toBe(true);
		expect(isAdmin(user('someone'))).toBe(false);
		expect(isAdmin(null)).toBe(false);
	});
});

describe('isModerator', () => {
	it('is true for moderators and admins (admins are a moderator superset)', () => {
		env.ADMIN_USER_IDS = 'boss';
		env.MODERATOR_USER_IDS = 'mod';
		expect(isModerator(user('mod'))).toBe(true);
		expect(isModerator(user('boss'))).toBe(true);
		expect(isModerator(user('editor'))).toBe(false);
		expect(isModerator(null)).toBe(false);
	});
});
