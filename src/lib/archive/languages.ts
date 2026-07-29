const ARCHIVE_LANGUAGE_NAMES: Record<string, string> = {
	ain: 'アイヌ語 Ainu',
	jpn: '日本語 Japanese',
	eng: 'English',
	rus: 'Русский Russian'
};

export function archiveLanguageNames(languages: readonly string[] | null | undefined): string[] {
	if (!languages?.length) return [];
	return languages
		.map((code) => code.trim())
		.filter(Boolean)
		.map((code) => ARCHIVE_LANGUAGE_NAMES[code.toLocaleLowerCase()] ?? code);
}

export function formatArchiveLanguages(languages: readonly string[] | null | undefined): string {
	return archiveLanguageNames(languages).join(' · ');
}

// 'ain' names every work in this collection — it is not a fact that tells
// one catalog card apart from another, so the catalog's own tags show only
// whatever else a work is written in. The full record, including Ainu,
// still belongs on the work page's bibliographic detail.
export function archiveCardLanguages(languages: readonly string[] | null | undefined): string[] {
	if (!languages?.length) return [];
	return archiveLanguageNames(languages.filter((code) => code.trim().toLocaleLowerCase() !== 'ain'));
}
