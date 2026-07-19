const ARCHIVE_LANGUAGE_NAMES: Record<string, string> = {
	ain: 'アイヌ語 Ainu',
	jpn: '日本語 Japanese',
	eng: 'English',
	rus: 'Русский Russian'
};

export function formatArchiveLanguages(languages: readonly string[] | null | undefined): string {
	if (!languages?.length) return '';
	return languages
		.map((code) => code.trim())
		.filter(Boolean)
		.map((code) => ARCHIVE_LANGUAGE_NAMES[code.toLocaleLowerCase()] ?? code)
		.join(' · ');
}
