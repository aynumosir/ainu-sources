/** Refresh the published ERDAL metadata; no transcription text is copied. */
import { writeFile } from 'node:fs/promises';
import { projectRecordsIndex } from '../src/lib/records-index';

const response = await fetch('https://rec.aynu.org/x/index.json', { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Records index: HTTP ${response.status}`);
const catalogueResponse = await fetch('https://db.aynu.org/api/sources/export.json', { signal: AbortSignal.timeout(30_000) });
if (!catalogueResponse.ok) throw new Error(`Catalogue export: HTTP ${catalogueResponse.status}`);
const index = projectRecordsIndex(await response.json(), await catalogueResponse.json());
await writeFile(new URL('../src/lib/records-index.json', import.meta.url), JSON.stringify(index, null, '\t') + '\n');
console.log(`Updated ${index.sources.length} early records.`);
