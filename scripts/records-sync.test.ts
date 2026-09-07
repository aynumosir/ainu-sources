import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncRecords } from './records-sync';

vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return { ...fs, writeFile: vi.fn(fs.writeFile), rename: vi.fn(fs.rename) };
});
const catalogue = [{ slug: 'work', status: 'active', old_slugs: [] }];
const index = { sources: [{ slug: 'record', catalogue: 'work', title: 'Title', titleLatin: 'Title', kind: 'prose',
	units: [{ slug: 'copy', label: '', pages: 1, items: 0, witness: { holder: 'Holder', holderEn: 'Holder' } }] }] };
let directory: string;
let destination: URL;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'records-sync-'));
	destination = pathToFileURL(join(directory, 'index.json'));
	await writeFile(destination, 'original snapshot');
	vi.stubGlobal('fetch', vi.fn()
		.mockResolvedValueOnce(Response.json(index))
		.mockResolvedValueOnce(Response.json(catalogue)));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(directory, { recursive: true, force: true });
});
it('replaces the snapshot after validation and rejects redirects on both fetches', async () => {
	expect(await syncRecords(destination)).toBe(1);
	expect(JSON.parse(await readFile(destination, 'utf8')).sources[0].catalogue).toBe('work');
	for (const call of vi.mocked(fetch).mock.calls) expect(call[1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
	expect(await readdir(directory)).toEqual(['index.json']);
});
it('preserves the snapshot when validation fails', async () => {
	vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json({ sources: [] })).mockResolvedValueOnce(Response.json(catalogue));
	await expect(syncRecords(destination)).rejects.toThrow('Expected nonempty sources');
	expect(await readFile(destination, 'utf8')).toBe('original snapshot');
	expect(await readdir(directory)).toEqual(['index.json']);
});
it('preserves the snapshot and removes a partially written temporary file on write failure', async () => {
	const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
	vi.mocked(writeFile).mockImplementationOnce(async (path) => {
		await fs.writeFile(path, '{partial');
		throw new Error('Simulated disk write failure');
	});
	await expect(syncRecords(destination)).rejects.toThrow('Simulated disk write failure');
	expect(await readFile(destination, 'utf8')).toBe('original snapshot');
	expect(await readdir(directory)).toEqual(['index.json']);
});

it('cleans up the temporary file when replacement fails', async () => {
	vi.mocked(rename).mockRejectedValueOnce(new Error('Simulated rename failure'));
	await expect(syncRecords(destination)).rejects.toThrow('Simulated rename failure');
	expect(await readFile(destination, 'utf8')).toBe('original snapshot');
	expect(await readdir(directory)).toEqual(['index.json']);
});
