/**
 * Measure how much of a text is written in each language.
 *
 * Every script in this collection is shared between languages: Ainu appears
 * in katakana beside Japanese and in Latin letters beside English, so the
 * script of a character never decides its language alone. Characters are
 * grouped into script runs per line; unambiguous scripts (han, hiragana,
 * cyrillic) are counted directly, while katakana and Latin runs are scored
 * against character-trigram profiles built from attested text of each
 * language (scripts/archive/build-language-profiles.ts). A run whose score
 * margin is too thin to trust falls back to the line's context — kana beside
 * hiragana and kanji reads as Japanese — and what still resists is counted
 * as 'und' rather than guessed.
 *
 * Dictionary lookup was tried for this and measured worse: common English
 * words inside bilingual entries matched Ainu headwords, and short particles
 * matched everything.
 */
import { and, eq } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import profilesJson from './language-profiles.json';
import { firstVariantWithChunks, listOcrPages, preferredVariant } from './ocr';
import { fileRevisions, sourceFiles, sources } from '$lib/server/db/schema';
import type * as schema from '$lib/server/db/schema';
import {
	CYRL_RUN,
	JPN_ANCHOR,
	KANA_RUN,
	LATN_RUN,
	canonicalKana,
	countMatchedChars,
	pooledUnit,
	runTrigrams,
	runsOf
} from './text-runs';
import type { CompositionShare, SourceTextComposition } from '$lib/archive/text-composition';

export const COMPOSITION_METHOD = 'run-trigrams-1';

type ProfileClass = { total: number; grams: Record<string, number> };
type ProfileChannel = Record<string, ProfileClass>;
type Profiles = {
	version: number;
	channels: { kana: ProfileChannel; latn: ProfileChannel };
};

const profiles = profilesJson as Profiles;

/**
 * Per-gram log-probability margin below which a run's own evidence is too
 * thin to name a language. Chosen against the labeled snippets in
 * language-composition.test.ts.
 */
const MARGIN = 0.05;

type Scorer = (unit: string) => { lang: string; margin: number };

/**
 * Smoothing floor as a relative frequency. The two profiles differ in size
 * by an order of magnitude, so scores compare frequencies, never raw counts:
 * count-based smoothing would turn corpus size itself into evidence.
 */
const EPSILON = 1e-6;

function makeScorer(channel: ProfileChannel, classes: [string, string]): Scorer {
	const [a, b] = classes;
	const pa = channel[a];
	const pb = channel[b];
	return (unit) => {
		let margin = 0;
		let informative = 0;
		for (const gram of runTrigrams(unit)) {
			const ca = pa.grams[gram];
			const cb = pb.grams[gram];
			// A gram neither profile knows carries no evidence either way.
			if (!ca && !cb) continue;
			margin += Math.log10(((ca ?? 0) / pa.total + EPSILON) / ((cb ?? 0) / pb.total + EPSILON));
			informative += 1;
		}
		if (informative === 0) return { lang: 'und', margin: 0 };
		margin /= informative;
		return { lang: margin >= 0 ? a : b, margin: Math.abs(margin) };
	};
}

const scoreKana = makeScorer(profiles.channels.kana, ['ain', 'jpn']);
const scoreLatn = makeScorer(profiles.channels.latn, ['ain', 'eng']);

export type CompositionMeasurement = { chars: number; shares: CompositionShare[] };

export function measureLanguageComposition(
	pages: readonly { text: string }[]
): CompositionMeasurement {
	const counts = new Map<string, number>();
	const add = (lang: string, chars: number) => {
		if (chars > 0) counts.set(lang, (counts.get(lang) ?? 0) + chars);
	};

	for (const page of pages) {
		for (const rawLine of page.text.split('\n')) {
			const line = rawLine.normalize('NFKC');
			const jpnAnchor = countMatchedChars(line, JPN_ANCHOR);
			add('jpn', jpnAnchor);
			add('rus', countMatchedChars(line, CYRL_RUN));

			const kanaRuns = runsOf(line, KANA_RUN);
			if (kanaRuns.length > 0) {
				const kanaChars = kanaRuns.reduce((sum, run) => sum + [...run].length, 0);
				const verdict = scoreKana(canonicalKana(pooledUnit(kanaRuns)));
				if (verdict.margin >= MARGIN) {
					add(verdict.lang, kanaChars);
				} else if (jpnAnchor >= 2) {
					// Kana embedded in a hiragana-and-kanji line is Japanese usage
					// even when the word itself is a borrowing.
					add('jpn', kanaChars);
				} else {
					add('und', kanaChars);
				}
			}

			const latnRuns = runsOf(line, LATN_RUN).map((run) => run.toLowerCase());
			if (latnRuns.length > 0) {
				const latnChars = latnRuns.reduce((sum, run) => sum + [...run].length, 0);
				const verdict = scoreLatn(pooledUnit(latnRuns));
				add(verdict.margin >= MARGIN ? verdict.lang : 'und', latnChars);
			}
		}
	}

	const chars = [...counts.values()].reduce((a, b) => a + b, 0);
	const shares = [...counts.entries()]
		.map(([lang, langChars]) => ({
			lang,
			chars: langChars,
			share: chars > 0 ? Math.round((langChars / chars) * 1000) / 1000 : 0
		}))
		.sort((a, b) => b.chars - a.chars);
	return { chars, shares };
}

type Db = LibSQLDatabase<typeof schema>;

/**
 * Measure a work's text across the current revisions of its text-bearing
 * files and store the result on sources.text_composition. Each revision
 * contributes its preferred variant, so the measurement reads the same text
 * the archive shows. Returns what was stored: null when the work has no
 * text, so a stale measurement never outlives its text.
 */
export async function refreshSourceTextComposition(
	db: Db,
	sourceId: string,
	now: Date = new Date()
): Promise<SourceTextComposition | null> {
	const revisions = await db
		.select({ revisionId: fileRevisions.id, role: sourceFiles.role })
		.from(sourceFiles)
		.innerJoin(fileRevisions, eq(fileRevisions.sourceFileId, sourceFiles.id))
		.where(and(eq(sourceFiles.sourceId, sourceId), eq(fileRevisions.isCurrent, true)))
		.orderBy(sourceFiles.sortOrder, sourceFiles.id);

	const inputs: Array<{ revisionId: string; variant: string }> = [];
	const pages: Array<{ text: string }> = [];
	for (const revision of revisions) {
		if (revision.role === 'derivative') continue;
		const variant =
			(await preferredVariant(db, revision.revisionId)) ??
			(await firstVariantWithChunks(db, revision.revisionId));
		if (!variant) continue;
		const rows = await listOcrPages(db, revision.revisionId, variant);
		if (rows.length === 0) continue;
		inputs.push({ revisionId: revision.revisionId, variant });
		for (const row of rows) pages.push({ text: row.text });
	}

	const measured = measureLanguageComposition(pages);
	const composition: SourceTextComposition | null =
		measured.chars === 0
			? null
			: {
					version: 1,
					method: COMPOSITION_METHOD,
					inputs,
					measuredAt: now.getTime(),
					chars: measured.chars,
					shares: measured.shares
				};
	await db.update(sources).set({ textComposition: composition }).where(eq(sources.id, sourceId));
	return composition;
}
