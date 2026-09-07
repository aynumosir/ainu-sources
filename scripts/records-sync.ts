import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { projectRecordsIndex } from '../src/lib/records-index';

/** Validate both published datasets before atomically replacing the local snapshot. */
export async function syncRecords(destination: URL): Promise<number> {
	const response = await fetch('https://rec.aynu.org/x/index.json', {
		signal: AbortSignal.timeout(30_000), redirect: 'error'
	});
	if (!response.ok) throw new Error(`Records index: HTTP ${response.status}`);
	const catalogueResponse = await fetch('https://db.aynu.org/api/sources/export.json', {
		signal: AbortSignal.timeout(30_000), redirect: 'error'
	});
	if (!catalogueResponse.ok) throw new Error(`Catalogue export: HTTP ${catalogueResponse.status}`);
	const index = projectRecordsIndex(await response.json(), await catalogueResponse.json());
	const serialized = JSON.stringify(index, null, '\t') + '\n';
	const temporary = new URL(destination);
	temporary.pathname += `.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, serialized, { flag: 'wx' });
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
	return index.sources.length;
}
