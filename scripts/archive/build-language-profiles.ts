#!/usr/bin/env bun
/**
 * Build the character-trigram language profiles that
 * src/lib/server/archive/language-composition.ts scores against, and write
 * them to src/lib/server/archive/language-profiles.json.
 *
 * Every profile is counted from attested text:
 *
 * - ain/latn — Latin-script runs of ainu-corpora records. The transcripts
 *   code-switch into Japanese in katakana, so taking only the Latin runs
 *   keeps the sample Ainu.
 * - ain/kana — the same Ainu vocabulary converted to katakana with ainconv,
 *   counted twice: once in modern orthography with small final kana, once
 *   with those kana at full size, the shape kana-only sources without the
 *   small-kana convention use.
 * - jpn/kana — katakana runs from the corpora's Japanese translations, plus
 *   katakana runs on hiragana-and-kanji lines of the archive's own OCR text.
 * - jpn/latn — the translations' kana romanized to Hepburn. Bibliographies
 *   and personal names put Japanese into Latin letters, where its syllable
 *   shapes coincide with Ainu's; the romaji profile separates them by what
 *   Ainu spelling never contains — voiced stops, geminates, long ou.
 * - eng — Latin runs of OCR lines that carry English function words and no
 *   Japanese script, so interlinear Ainu example lines stay out of the
 *   English sample even when they are pure ASCII.
 *
 * Besides the trigram profiles, the output carries the well-attested Ainu
 * Latin vocabulary (frequency and length floors below). Romanized Japanese
 * scores as Ainu-like on trigrams alone — the syllable shapes coincide — so
 * a single word may only outvote its line where the word itself is attested
 * Ainu.
 *
 * Deterministic over its inputs; rerun after the corpora change materially.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertLatnToKana } from 'ainconv';
import {
	JPN_ANCHOR,
	KANA_RUN,
	LATN_RUN,
	canonicalKana,
	countMatchedChars,
	pooledUnit,
	runTrigrams,
	runsOf
} from '../../src/lib/server/archive/text-runs';

const SCRIPT_DIR =
	(import.meta as ImportMeta & { dir?: string }).dir ?? path.dirname(fileURLToPath(import.meta.url));
const AINU_ROOT = process.env.AINU_ROOT ?? path.resolve(SCRIPT_DIR, '../../..');
const OUT_PATH = path.resolve(SCRIPT_DIR, '../../src/lib/server/archive/language-profiles.json');

/** Grams kept per class: enough to cover each language's common sequences without bloating the bundle. */
const TOP_GRAMS = 5000;
/** A word enters the attested-Ainu lexicon with at least this many corpus occurrences… */
const LEXICON_MIN_COUNT = 50;
/** …and this many characters — shorter forms collide with too many languages. */
const LEXICON_MIN_LENGTH = 4;

/**
 * Words frequent in English prose and absent from Ainu — 'to', 'a', or 'an'
 * would misfire, all three are Ainu words. Two distinct hits mark a line as
 * English for training.
 */
const ENGLISH_MARKERS = new Set([
	'the', 'of', 'and', 'is', 'was', 'are', 'that', 'with', 'this', 'which', 'from', 'by'
]);

const SMALL_KANA_UPSIZE: Record<string, string> = {
	ㇰ: 'ク', ㇱ: 'シ', ㇲ: 'ス', ㇳ: 'ト', ㇴ: 'ヌ', ㇵ: 'ハ', ㇶ: 'ヒ', ㇷ: 'フ',
	ㇸ: 'ヘ', ㇹ: 'ホ', ㇺ: 'ム', ㇻ: 'ラ', ㇼ: 'リ', ㇽ: 'ル', ㇾ: 'レ', ㇿ: 'ロ',
	ァ: 'ア', ィ: 'イ', ゥ: 'ウ', ェ: 'エ', ォ: 'オ', ッ: 'ツ', ャ: 'ヤ', ュ: 'ユ', ョ: 'ヨ'
};

function upsizeSmallKana(text: string): string {
	return [...text].map((c) => SMALL_KANA_UPSIZE[c] ?? c).join('');
}

const KANA_ROMAJI: Record<string, string> = {
	ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
	カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
	ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
	サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
	ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
	タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
	ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
	ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
	ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
	バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
	パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
	マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
	ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
	ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
	ワ: 'wa', ヲ: 'o', ヴ: 'vu',
	ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o'
};
const ROMAJI_DIGRAPH_SECOND: Record<string, string> = { ャ: 'ya', ュ: 'yu', ョ: 'yo' };

/**
 * Hepburn romanization of a kana run, enough for trigram statistics: digraph
 * palatals, geminates, syllabic n, and ー as a repeat of the last vowel.
 */
function romanizeKana(run: string): string {
	const kata = [...run.normalize('NFKC')].map((c) => {
		const code = c.codePointAt(0)!;
		return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : c;
	});
	let out = '';
	let geminate = false;
	for (let i = 0; i < kata.length; i += 1) {
		const c = kata[i];
		if (c === 'ッ') {
			geminate = true;
			continue;
		}
		if (c === 'ン') {
			out += 'n';
			continue;
		}
		if (c === 'ー') {
			const vowel = out.match(/[aeiou](?=[^aeiou]*$)/u)?.[0];
			if (vowel) out += vowel;
			continue;
		}
		let syllable = KANA_ROMAJI[c];
		if (!syllable) continue;
		const next = ROMAJI_DIGRAPH_SECOND[kata[i + 1] ?? ''];
		if (next && syllable.endsWith('i')) {
			const head = syllable.slice(0, -1);
			syllable =
				head === 'sh' || head === 'ch' || head === 'j' ? head + next.slice(1) : head + next;
			i += 1;
		}
		if (geminate) {
			out += syllable[0] === 'c' ? 't' : syllable[0];
			geminate = false;
		}
		out += syllable;
	}
	return out;
}

class GramCounter {
	grams = new Map<string, number>();
	total = 0;
	addUnit(unit: string, weight = 1) {
		for (const gram of runTrigrams(unit)) {
			this.grams.set(gram, (this.grams.get(gram) ?? 0) + weight);
			this.total += weight;
		}
	}
	toProfile() {
		const kept = [...this.grams.entries()]
			.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
			.slice(0, TOP_GRAMS)
			.sort((x, y) => (x[0] < y[0] ? -1 : 1));
		return { total: this.total, grams: Object.fromEntries(kept) };
	}
}

async function collectOcrLines(): Promise<string[]> {
	const lines: string[] = [];
	for (const subdir of ['books', 'articles']) {
		const dir = path.join(AINU_ROOT, 'ainu-grammar', subdir, 'ocr');
		let entries: string[] = [];
		try {
			entries = await fs.readdir(dir);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (!entry.endsWith('.txt')) continue;
			const text = await fs.readFile(path.join(dir, entry), 'utf8');
			for (const line of text.split('\n')) lines.push(line.normalize('NFKC'));
		}
	}
	return lines;
}

async function main() {
	const corpusPath = path.join(AINU_ROOT, 'ainu-corpora', 'data.jsonl');
	const corpus = (await fs.readFile(corpusPath, 'utf8')).split('\n').filter(Boolean);

	const ainLatn = new GramCounter();
	const ainKana = new GramCounter();
	const jpnKana = new GramCounter();
	const jpnLatn = new GramCounter();
	const eng = new GramCounter();
	const ALL_KANA_RUN = /[\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

	// Ainu: Latin runs of corpus records; the kana profile converts each
	// distinct word once, weighted by its corpus frequency.
	const ainVocab = new Map<string, number>();
	for (const record of corpus) {
		const { text, translation } = JSON.parse(record) as { text?: string; translation?: string };
		if (text) {
			const runs = runsOf(text.normalize('NFKC'), LATN_RUN).map((r) => r.toLowerCase());
			if (runs.length > 0) {
				ainLatn.addUnit(pooledUnit(runs));
				for (const run of runs) ainVocab.set(run, (ainVocab.get(run) ?? 0) + 1);
			}
		}
		if (translation) {
			const runs = runsOf(translation.normalize('NFKC'), KANA_RUN);
			if (runs.length > 0) jpnKana.addUnit(canonicalKana(pooledUnit(runs)));
			const romaji = runsOf(translation.normalize('NFKC'), ALL_KANA_RUN)
				.map((run) => romanizeKana(run))
				.filter(Boolean);
			if (romaji.length > 0) jpnLatn.addUnit(pooledUnit(romaji));
		}
	}
	for (const [word, count] of ainVocab) {
		let kana: string;
		try {
			kana = convertLatnToKana(word);
		} catch {
			continue;
		}
		if (!kana || /[a-z]/u.test(kana)) continue; // words the converter cannot express in kana
		const weight = Math.min(count, 500); // cap so one story's refrain cannot dominate
		const canonical = canonicalKana(kana);
		ainKana.addUnit(pooledUnit([canonical]), weight);
		ainKana.addUnit(pooledUnit([upsizeSmallKana(canonical)]), weight);
	}

	const ocrLines = await collectOcrLines();
	for (const line of ocrLines) {
		const jpnAnchor = countMatchedChars(line, JPN_ANCHOR);
		const kanaRuns = runsOf(line, KANA_RUN);
		if (jpnAnchor >= 6 && jpnAnchor >= [...line].length * 0.3 && kanaRuns.length > 0) {
			jpnKana.addUnit(canonicalKana(pooledUnit(kanaRuns)));
		}

		if (jpnAnchor > 0) continue;
		const latnRuns = runsOf(line, LATN_RUN).map((r) => r.toLowerCase());
		if (latnRuns.length < 3) continue;
		const markers = new Set(latnRuns.filter((r) => ENGLISH_MARKERS.has(r)));
		if (markers.size < 2) continue;
		eng.addUnit(pooledUnit(latnRuns));
	}

	const classes = [
		['ain/latn', ainLatn],
		['ain/kana', ainKana],
		['jpn/kana', jpnKana],
		['jpn/latn', jpnLatn],
		['eng/latn', eng]
	] as const;
	// An empty class would make every comparison against it NaN at scoring
	// time; refuse to write a profile that cannot score.
	for (const [name, counter] of classes) {
		if (counter.total === 0) throw new Error(`${name} counted no grams — check AINU_ROOT inputs`);
	}
	const lexicon = [...ainVocab.entries()]
		.filter(([word, count]) => count >= LEXICON_MIN_COUNT && [...word].length >= LEXICON_MIN_LENGTH)
		.map(([word]) => word)
		.sort();

	const out = {
		version: 1,
		channels: {
			kana: { ain: ainKana.toProfile(), jpn: jpnKana.toProfile() },
			latn: { ain: ainLatn.toProfile(), eng: eng.toProfile(), jpn: jpnLatn.toProfile() }
		},
		lexicon: { ainLatn: lexicon }
	};
	await fs.writeFile(OUT_PATH, `${JSON.stringify(out)}\n`);
	for (const [name, counter] of classes) {
		console.log(
			`${name}: ${counter.total} grams counted, ${Math.min(counter.grams.size, TOP_GRAMS)} kept`
		);
	}
	console.log(`lexicon ain/latn: ${lexicon.length} words`);
	console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

await main();
