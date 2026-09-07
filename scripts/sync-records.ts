/** Refresh the published ERDAL metadata; no transcription text is copied. */
import { syncRecords } from './records-sync';

const count = await syncRecords(new URL('../src/lib/records-index.json', import.meta.url));
console.log(`Updated ${count} early records.`);
