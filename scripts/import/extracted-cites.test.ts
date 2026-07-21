import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DATA_DIR = path.join(import.meta.dir, '..', 'data', 'extracted-cites');

interface ExtractedReference {
	n: number;
	title?: string;
	authors?: string[];
}

interface ExtractedCitesFile {
	schema?: string;
	citingWork?: { slug?: string };
	extraction?: { referenceCount?: number };
	references?: ExtractedReference[];
}

describe('extracted citation data', () => {
	for (const filename of fs.readdirSync(DATA_DIR).filter((name) => name.endsWith('.json')).sort()) {
		it(`${filename} has a complete, numbered reference list`, () => {
			const data = JSON.parse(
				fs.readFileSync(path.join(DATA_DIR, filename), 'utf8')
			) as ExtractedCitesFile;
			const references = data.references ?? [];

			expect(data.schema).toBe('extracted-cites/v1');
			expect(data.citingWork?.slug).toBeTruthy();
			expect(references).toHaveLength(data.extraction?.referenceCount ?? -1);
			expect(references.map((ref) => ref.n)).toEqual(
				Array.from({ length: references.length }, (_, index) => index + 1)
			);
			expect(references.every((ref) => Boolean(ref.title) && Boolean(ref.authors?.length))).toBe(true);
		});
	}
});
