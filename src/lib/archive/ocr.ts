export type OcrCoverageStatus = 'none' | 'partial' | 'complete';

/** How a text variant came to exist. Recognition is one of these, not all. */
export type TextSourceKind = 'extracted' | 'recognized' | 'converted' | 'curated' | 'edited';

export const TEXT_SOURCE_LABELS: Record<TextSourceKind, { ja: string; en: string; note: string }> = {
	extracted: {
		ja: '本文レイヤー',
		en: 'Publisher text',
		note: '出版物に含まれる本文を取り出したもの。 Taken from text the file already carried.'
	},
	recognized: {
		ja: '文字認識',
		en: 'Recognized',
		note: '画像から機械が読み取ったもの。誤りを含む。 Read from the page image by a machine; contains errors.'
	},
	converted: {
		ja: '変換',
		en: 'Converted',
		note: '別形式の原資料から変換したもの。 Converted from a source document in another format.'
	},
	curated: {
		ja: '校訂',
		en: 'Curated',
		note: '人手で校訂された本文。 Transcribed and checked by a person.'
	},
	edited: {
		ja: '校正済み',
		en: 'Corrected here',
		note: 'この記録庫で人手により修正されたもの。 Corrected by hand in this archive.'
	}
};

export type OcrCoverage = {
	revisionId: string;
	variant: string;
	sourceKind?: TextSourceKind;
	reliability?: 'unassessed' | 'suspect';
	reliabilityNote?: string | null;
	status: OcrCoverageStatus;
	tool: string | null;
	toolVersion: string | null;
	preferred: boolean;
	pageCount: number;
};

export type OcrSummary = {
	state: 'available' | 'partial' | 'unreadable' | 'none';
	label: string;
};

export function ocrEngineLabel(coverage: Pick<OcrCoverage, 'tool' | 'variant'>): string {
	return coverage.tool?.trim() || coverage.variant;
}

export function textBearingVariants(coverage: OcrCoverage[]): OcrCoverage[] {
	return coverage.filter((variant) => variant.status !== 'none');
}

export function summarizeOcrCoverage(coverage: OcrCoverage[]): OcrSummary {
	const variants = textBearingVariants(coverage);
	if (variants.length === 0) return { state: 'none', label: '本文なし / no text' };

	const detail = variants.length === 1 ? ocrEngineLabel(variants[0]) : `${variants.length} versions`;
	// Text that cannot be read is not text a reader can use, and saying "text
	// available" of it sends someone to a page of fragments.
	if (variants.every((variant) => variant.reliability === 'suspect')) {
		return { state: 'unreadable', label: `読めない本文 / unreadable · ${detail}` };
	}
	if (variants.every((variant) => variant.status === 'partial')) {
		return { state: 'partial', label: `一部 / partial · ${detail}` };
	}
	return { state: 'available', label: `本文あり / text · ${detail}` };
}

export function chooseDefaultOcrVariant(coverage: OcrCoverage[]): string | null {
	const variants = textBearingVariants(coverage);
	const preferred = variants.find((variant) => variant.preferred);
	if (preferred) return preferred.variant;
	return [...variants].sort(
		(left, right) => right.pageCount - left.pageCount || left.variant.localeCompare(right.variant)
	)[0]?.variant ?? null;
}
