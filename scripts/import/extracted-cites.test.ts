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
	verified?: boolean;
	citingWork?: { slug?: string };
	extraction?: { referenceCount?: number };
	references?: (ExtractedReference & { match?: { slug?: string } })[];
}

function dataFiles(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return dataFiles(full);
		return entry.name.endsWith('.json') ? [full] : [];
	});
}

describe('extracted citation data', () => {
	for (const filename of dataFiles(DATA_DIR).sort()) {
		it(`${path.relative(DATA_DIR, filename)} has a complete, numbered reference list`, () => {
			const data = JSON.parse(fs.readFileSync(filename, 'utf8')) as ExtractedCitesFile;
			const references = data.references ?? [];

			expect(data.schema).toBe('extracted-cites/v1');
			expect(data.citingWork?.slug).toBeTruthy();
			expect(references).toHaveLength(data.extraction?.referenceCount ?? -1);
			expect(references.map((ref) => ref.n)).toEqual(
				Array.from({ length: references.length }, (_, index) => index + 1)
			);
			expect(references.every((ref) => Boolean(ref.title))).toBe(true);
			if (data.verified) {
				expect(references.every((ref) => Boolean(ref.authors?.length))).toBe(true);
			} else {
				expect(references.every((ref) => Boolean(ref.match?.slug))).toBe(true);
			}
		});
	}
});
