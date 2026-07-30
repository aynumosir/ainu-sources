/**
 * Measured language composition of a work's text, stored on
 * sources.text_composition. Shares are fractions of the classified character
 * mass, so they answer "how much of this work's text is in each language"
 * rather than listing every language the work touches.
 */
export type CompositionShare = {
	/** ISO-ish code: ain, jpn, eng, rus — or 'und' where the text resisted classification. */
	lang: string;
	/** Fraction of the classified character mass, 0..1. */
	share: number;
	/** Classified characters counted for this language. */
	chars: number;
};

export type SourceTextComposition = {
	version: 1;
	/** Identifier of the measuring procedure, so a stored result can be re-derived. */
	method: string;
	/** The revision texts the measurement read — one per file of the work that carries text. */
	inputs: Array<{ revisionId: string; variant: string }>;
	measuredAt: number;
	/** Total classified characters across the work. */
	chars: number;
	/** Descending by share. */
	shares: CompositionShare[];
};

/** Below this much classified text, a share is noise rather than a measurement. */
export const COMPOSITION_MIN_CHARS = 500;

const COMPOSITION_LANGUAGE_NAMES: Record<string, string> = {
	ain: 'アイヌ語',
	jpn: '日本語',
	eng: 'English',
	rus: 'Русский'
};

export function compositionLanguageName(lang: string): string {
	return COMPOSITION_LANGUAGE_NAMES[lang] ?? lang;
}

/**
 * The shares a reader should see: named languages carrying at least 1% of the
 * text, largest first. Unclassifiable residue ('und') stays out of the label —
 * it is visible in the stored record, and a card that says "und 3%" would
 * name the measurement's limit, never the work.
 */
export function displayShares(
	composition: SourceTextComposition | null | undefined
): CompositionShare[] {
	if (!composition || composition.chars < COMPOSITION_MIN_CHARS) return [];
	return composition.shares.filter((s) => s.lang !== 'und' && s.share >= 0.01);
}

export function formatShare(share: number): string {
	const percent = Math.round(share * 100);
	return `${percent < 1 ? '<1' : percent}%`;
}
