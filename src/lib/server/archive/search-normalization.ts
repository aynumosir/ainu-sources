import { convertKanaToLatn } from 'ainconv';

export const OCR_NORMALIZATION_VERSION = 1;

const APOSTROPHES = /[\u0060\u00b4\u02b9\u02bc\u055a\u2018\u2019\u201b\uff07]/gu;
const KANA_RUN = /[\p{Script_Extensions=Katakana}\p{Script_Extensions=Hiragana}\u3099\u309a\u30fb\u30fc]+/gu;
const TOKEN = /[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu;

const LOSSY_LATIN_GROUPS = [
	['tu', 'tow'],
	['ai', 'ay', 'a.i'],
	['ui', 'uy', 'u.i'],
	['ei', 'ey', 'e.i'],
	['oi', 'oy', 'o.i'],
	['au', 'aw', 'a.u'],
	['iu', 'iw', 'i.u'],
	['eu', 'ew', 'e.u'],
	['ou', 'ow', 'o.u']
] as const;

export type NormalizedToken = { token: string; position: number };

export function normalizeOcrText(text: string): string {
	const nfc = text.normalize('NFC').replace(APOSTROPHES, "'");
	const latin = nfc.replace(KANA_RUN, (run) => convertKanaToLatn(run));
	return latin
		.normalize('NFD')
		.replace(/\p{M}+/gu, '')
		.toLocaleLowerCase('und')
		.replaceAll('ß', 'ss')
		.normalize('NFC');
}

export function tokenizeNormalizedText(text: string): NormalizedToken[] {
	return [...normalizeOcrText(text).matchAll(TOKEN)].map((match, position) => ({
		token: match[0],
		position
	}));
}

export function expandNormalizedTokenAlternatives(token: string): string[] {
	const normalized = normalizeOcrText(token);
	const alternatives = new Set([normalized]);
	const queue = [normalized];
	while (queue.length > 0 && alternatives.size < 32) {
		const value = queue.shift()!;
		for (const group of LOSSY_LATIN_GROUPS) {
			for (const form of group) {
				let index = value.indexOf(form);
				while (index !== -1) {
					for (const alternative of group) {
						const expanded = value.slice(0, index) + alternative + value.slice(index + form.length);
						if (!alternatives.has(expanded)) {
							alternatives.add(expanded);
							queue.push(expanded);
						}
					}
					index = value.indexOf(form, index + 1);
				}
			}
		}
	}
	return [...alternatives];
}

export function escapeFtsLiteral(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function literalPhraseAlternatives(value: string): string[] {
	const original = value.normalize('NFC');
	const normalized = normalizeOcrText(original);
	return original === normalized ? [original] : [original, normalized];
}
