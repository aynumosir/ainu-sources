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
 * - eng — Latin runs of OCR lines that carry English function words and no
 *   Japanese script, so interlinear Ainu example lines stay out of the
 *   English sample even when they are pure ASCII.
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
	const eng = new GramCounter();

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

	const out = {
		version: 1,
		channels: {
			kana: { ain: ainKana.toProfile(), jpn: jpnKana.toProfile() },
			latn: { ain: ainLatn.toProfile(), eng: eng.toProfile() }
		}
	};
	await fs.writeFile(OUT_PATH, `${JSON.stringify(out)}\n`);
	for (const [name, counter] of [
		['ain/latn', ainLatn],
		['ain/kana', ainKana],
		['jpn/kana', jpnKana],
		['eng/latn', eng]
	] as const) {
		console.log(
			`${name}: ${counter.total} grams counted, ${Math.min(counter.grams.size, TOP_GRAMS)} kept`
		);
	}
	console.log(`wrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

await main();
