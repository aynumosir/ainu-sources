import index from './records-index.json';
import type { EarlyRecord } from './records-index';

export const earlyRecords: EarlyRecord[] = index.sources;

/** A work includes all copies. A separately catalogued witness includes only its own volumes. */
export function recordsForCatalogue(slug: string): EarlyRecord[] {
	return earlyRecords.flatMap((record) => {
		if (record.catalogue === slug) return [record];
		const units = record.units.filter((unit) => unit.catalogue === slug);
		return units.length ? [{ ...record, units }] : [];
	});
}

/** ERDAL offers Japanese and English; Russian and Ainu readers use English. */
export function recordsHref(path = '', locale = 'en'): string {
	return `https://rec.aynu.org${locale === 'ja' ? '/ja' : ''}${path || '/'}`;
}

export function recordsLinks(slug: string) {
	return recordsForCatalogue(slug).map((record) => ({
		url: recordsHref(`/sources/${record.slug}`),
		entries_url: record.kind === 'wordlist' && record.catalogue === slug ? recordsHref(`/sources/${record.slug}/entries`) : null,
		units: record.units.map((unit) => ({
			url: recordsHref(`/sources/${record.slug}/${unit.slug}/1`),
			tei_url: recordsHref(`/export/tei/${record.slug}/${unit.slug}.xml`),
			holder: unit.holder, shelfmark: unit.shelfmark, pages: unit.pages, items: unit.items
		}))
	}));
}
