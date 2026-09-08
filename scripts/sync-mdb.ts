import { syncMdb } from './mdb-sync';

const count = await syncMdb(new URL('../src/lib/mdb-index.json', import.meta.url));
console.log(`Updated ${count} dictionary links.`);
