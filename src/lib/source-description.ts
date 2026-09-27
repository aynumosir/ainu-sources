/** Choose catalogue prose without changing the language of the work itself. */
export function localizedSummary(
	source: { summary?: string | null; summaryJa?: string | null },
	locale: string
): string {
	const original = source.summary?.trim() ?? '';
	const japanese = source.summaryJa?.trim() ?? '';
	return locale === 'ja' ? japanese || original : original || japanese;
}
