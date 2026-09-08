import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { syncMdb } from './mdb-sync';

vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return { ...fs, rename: vi.fn(fs.rename) };
});
const index = { version: 1, sources: [{ id: 'Dictionary', catalogue: 'old', title: 'Title', lexemes: 2 }] };
const catalogue = [{ slug: 'work', status: 'active', old_slugs: ['old'] }];
let directory: string;
let destination: URL;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'mdb-sync-'));
	destination = pathToFileURL(join(directory, 'index.json'));
	await writeFile(destination, 'original');
	vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(index)).mockResolvedValueOnce(Response.json(catalogue)));
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(directory, { recursive: true, force: true });
});
it('validates both exports before atomically replacing the snapshot', async () => {
	expect(await syncMdb(destination)).toBe(1);
	expect(JSON.parse(await readFile(destination, 'utf8')).sources[0].catalogue).toBe('work');
	expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
		'https://mdb.aynu.org/api/dictionaries', 'https://db.aynu.org/api/sources/export.json'
	]);
	for (const [, options] of vi.mocked(fetch).mock.calls) expect(options).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
	expect(await readdir(directory)).toEqual(['index.json']);
});
it.each(['network', 'http', 'schema', 'catalogue', 'rename'])('keeps the previous snapshot on %s failure', async (failure) => {
	if (failure === 'network') vi.mocked(fetch).mockReset().mockRejectedValue(new Error('offline'));
	if (failure === 'http') vi.mocked(fetch).mockReset().mockResolvedValue(new Response('', { status: 503 }));
	if (failure === 'schema') vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(Response.json(catalogue));
	if (failure === 'catalogue') vi.mocked(fetch).mockReset().mockResolvedValueOnce(Response.json(index)).mockResolvedValueOnce(Response.json([]));
	if (failure === 'rename') vi.mocked(rename).mockRejectedValueOnce(new Error('rename failed'));
	await expect(syncMdb(destination)).rejects.toThrow();
	expect(await readFile(destination, 'utf8')).toBe('original');
	expect(await readdir(directory)).toEqual(['index.json']);
});
