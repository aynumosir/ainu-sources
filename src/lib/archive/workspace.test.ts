import { describe, expect, it } from 'vitest';
import {
	acceptSavedBuffer,
	makeEditBuffer,
	resolveConflictChoice,
	restoreIntoBuffer,
	shapeExportFilename,
	updateEditBuffer
} from './workspace';

describe('workspace edit buffers', () => {
	it('tracks dirty text against the last accepted save', () => {
		const initial = makeEditBuffer({ text: 'kamuy', base: { kind: 'variant', variant: 'tesseract-5.3' } });
		const dirty = updateEditBuffer(initial, 'kamuy\n');
		expect(dirty.dirty).toBe(true);
		expect(updateEditBuffer(dirty, 'kamuy').dirty).toBe(false);

		const saved = acceptSavedBuffer(dirty, { edit_id: 'edit-2', variant: 'edited' });
		expect(saved).toMatchObject({ dirty: false, savedText: 'kamuy\n', base: { kind: 'edit', edit_id: 'edit-2' } });
		expect(restoreIntoBuffer(saved, 'older text').dirty).toBe(true);
	});
});

describe('workspace conflict choices', () => {
	const theirs = { edit_id: 'edit-3', edited_by: 'reviewer', edited_at: '2026-07-19T12:00:00Z', text: 'theirs' };
	const mine = updateEditBuffer(makeEditBuffer({ text: 'base', base: { kind: 'edit', edit_id: 'edit-1' } }), 'mine');

	it('accepts the current server head as a clean buffer', () => {
		expect(resolveConflictChoice(mine, theirs, 'theirs')).toEqual({
			buffer: {
				...mine,
				text: 'theirs',
				savedText: 'theirs',
				base: { kind: 'edit', edit_id: 'edit-3' },
				dirty: false
			},
			retry: false
		});
	});

	it('requires a note before retrying with local text', () => {
		expect(() => resolveConflictChoice(mine, theirs, 'mine')).toThrow('overwrite note');
		expect(resolveConflictChoice(mine, theirs, 'mine', 'checked against scan')).toMatchObject({
			retry: true,
			note: 'checked against scan',
			buffer: { text: 'mine', base: { kind: 'edit', edit_id: 'edit-3' }, dirty: true }
		});
	});
});

describe('shapeExportFilename', () => {
	it('uses the revision, selection, and extension from the export contract', () => {
		expect(shapeExportFilename('Ainu Dictionary', 12, 'working', 'txt')).toBe('ainu-dictionary.r12.working.txt');
		expect(shapeExportFilename('../', -1, 'approved', 'jsonl')).toBe('archive-text.r0.approved.jsonl');
	});
});
