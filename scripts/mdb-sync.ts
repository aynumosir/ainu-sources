import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { projectMdbIndex } from '../src/lib/mdb-index';

export async function syncMdb(destination: URL): Promise<number> {
	const fetchJson = async (url: string) => {
		const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
		if (!response.ok) throw new Error(`Index fetch: HTTP ${response.status}`);
		return response.json();
	};
	const index = projectMdbIndex(
		await fetchJson('https://mdb.aynu.org/api/dictionaries'),
		await fetchJson('https://db.aynu.org/api/sources/export.json')
	);
	const temporary = new URL(destination);
	temporary.pathname += `.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify(index, null, '\t') + '\n', { flag: 'wx' });
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
	return index.sources.length;
}
