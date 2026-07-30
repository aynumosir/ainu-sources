/**
 * Measure how much of a text is written in each language.
 *
 * Every script in this collection is shared between languages: Ainu appears
 * in katakana beside Japanese and in Latin letters beside English, so the
 * script of a character never decides its language alone. Characters are
 * grouped into script runs per line; unambiguous scripts (han, hiragana,
 * cyrillic) are counted directly, while katakana and Latin runs are scored
 * against character-trigram profiles built from attested text of each
 * language (scripts/archive/build-language-profiles.ts).
 *
 * Runs are judged individually first, so a dictionary line that sets an
 * Ainu headword against an English gloss keeps both languages. Runs too
 * short or too ambiguous to stand alone are pooled with their line's other
 * runs of the same script, then fall back to the line's context — kana
 * beside hiragana and kanji reads as Japanese — and what still resists is
 * counted as 'und' rather than guessed. A verdict also needs the profiles
 * to actually know the text: a run whose trigrams are mostly unknown to
 * both languages is 'und' no matter how its known scraps lean.
 *
 * Dictionary lookup was tried for this and measured worse: common English
 * words inside bilingual entries matched Ainu headwords, and short
 * particles matched everything.
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

export const COMPOSITION_METHOD = 'run-trigrams-2';

type ProfileClass = { total: number; grams: Record<string, number> };
type ProfileChannel = Record<string, ProfileClass>;
type Profiles = {
	version: number;
	channels: { kana: ProfileChannel; latn: ProfileChannel };
	lexicon: { ainLatn: string[] };
};

const profiles = profilesJson as Profiles;
const ainLatnLexicon = new Set(profiles.lexicon.ainLatn);

/**
 * Per-gram log-probability margin below which a pooled line's evidence is
 * too thin to name a language. Chosen against the labeled snippets in
 * language-composition.test.ts.
 */
const MARGIN = 0.05;
/**
 * A single run overrides its line's pooled verdict only on strong evidence:
 * short runs and loanwords score noisily on their own, so the bar for
 * standing alone is much higher than for the pooled unit.
 */
const RUN_MARGIN = 0.5;
const RUN_MIN_CHARS = 4;
/**
 * Share of a unit's trigrams at least one profile must know. Below this the
 * text is something neither language's attested writing contains — OCR
 * corruption, another language — and known scraps must not speak for it.
 */
const MIN_COVERAGE = 0.3;

/**
 * Smoothing floor as a relative frequency. The two profiles differ in size
 * by an order of magnitude, so scores compare frequencies, never raw counts:
 * count-based smoothing would turn corpus size itself into evidence.
 */
const EPSILON = 1e-6;

type Verdict = { lang: string; margin: number; coverage: number };
type Scorer = (unit: string) => Verdict;

function makeScorer(channel: ProfileChannel, classes: string[]): Scorer {
	const entries = classes.map((lang) => {
		const profile = channel[lang];
		if (!profile?.total) {
			throw new Error(`language profile for ${lang} is empty — regenerate archive:build-language-profiles`);
		}
		return { lang, profile };
	});
	return (unit) => {
		const scores = entries.map(() => 0);
		let informative = 0;
		let grams = 0;
		for (const gram of runTrigrams(unit)) {
			grams += 1;
			// A gram no profile knows carries no evidence for any class, but
			// its share of the unit caps how far the verdict can be trusted.
			if (!entries.some((e) => e.profile.grams[gram])) continue;
			informative += 1;
			for (let i = 0; i < entries.length; i += 1) {
				const { profile } = entries[i];
				scores[i] += Math.log10((profile.grams[gram] ?? 0) / profile.total + EPSILON);
			}
		}
		if (informative === 0) return { lang: 'und', margin: 0, coverage: 0 };
		const ranked = entries
			.map((e, i) => ({ lang: e.lang, score: scores[i] / informative }))
			.sort((x, y) => y.score - x.score);
		return {
			lang: ranked[0].lang,
			margin: ranked[0].score - ranked[1].score,
			coverage: informative / grams
		};
	};
}

const scoreKana = makeScorer(profiles.channels.kana, ['ain', 'jpn']);
const scoreLatn = makeScorer(profiles.channels.latn, ['ain', 'eng', 'jpn']);

type StandsAlone = (run: string, verdict: Verdict, chars: number) => boolean;

const confidentAlone = (verdict: Verdict, chars: number) =>
	chars >= RUN_MIN_CHARS && verdict.margin >= RUN_MARGIN && verdict.coverage >= MIN_COVERAGE;

const kanaStandsAlone: StandsAlone = (run, verdict, chars) => confidentAlone(verdict, chars);

// Romanized Japanese shares Ainu's syllable shapes, so trigram confidence
// alone would let a bibliography's "Tamura" or "doshi" outvote its English
// line. An Ainu verdict may stand alone only for attested Ainu vocabulary.
const latnStandsAlone: StandsAlone = (run, verdict, chars) =>
	confidentAlone(verdict, chars) && (verdict.lang !== 'ain' || ainLatnLexicon.has(run));

const poolDecides = (v: Verdict) => v.margin >= MARGIN && v.coverage >= MIN_COVERAGE;

/**
 * Classify one line's runs of a single script channel: confident runs keep
 * their own language, the rest pool into one unit whose verdict — or the
 * caller's context fallback — covers them.
 */
function classifyRuns(
	runs: string[],
	score: Scorer,
	standsAlone: StandsAlone,
	fallback: string,
	add: (lang: string, chars: number) => void
) {
	const pooled: string[] = [];
	let pooledChars = 0;
	for (const run of runs) {
		const chars = [...run].length;
		const verdict = score(` ${run} `);
		if (standsAlone(run, verdict, chars)) {
			add(verdict.lang, chars);
		} else {
			pooled.push(run);
			pooledChars += chars;
		}
	}
	if (pooled.length === 0) return;
	const verdict = score(pooledUnit(pooled));
	add(poolDecides(verdict) ? verdict.lang : fallback, pooledChars);
}

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

			// Character mass is counted on the canonical form, so ㇷ゚ and プ
			// weigh the same; runs with no kana letter at all (stray ー or
			// voicing marks) are OCR debris, not text in any language.
			const kanaRuns = runsOf(line, KANA_RUN)
				.map((run) => canonicalKana(run))
				.filter((run) => /\p{Script=Katakana}/u.test(run));
			// Kana embedded in a hiragana-and-kanji line is Japanese usage
			// even when the word itself is a borrowing.
			classifyRuns(kanaRuns, scoreKana, kanaStandsAlone, jpnAnchor >= 2 ? 'jpn' : 'und', add);

			const latnRuns = runsOf(line, LATN_RUN).map((run) => run.toLowerCase());
			classifyRuns(latnRuns, scoreLatn, latnStandsAlone, 'und', add);
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
 * contributes its preferred variant — or, when the preferred variant has no
 * ingested text, the first variant that does — so the measurement reads the
 * same text the archive shows. Returns what was stored: null when the work
 * has no text, so a stale measurement never outlives its text.
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
		let rows: Awaited<ReturnType<typeof listOcrPages>> = [];
		let variant = await preferredVariant(db, revision.revisionId);
		if (variant) rows = await listOcrPages(db, revision.revisionId, variant);
		if (rows.length === 0) {
			variant = await firstVariantWithChunks(db, revision.revisionId);
			if (variant) rows = await listOcrPages(db, revision.revisionId, variant);
		}
		if (!variant || rows.length === 0) continue;
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
