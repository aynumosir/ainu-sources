export type OcrCoverageStatus = 'none' | 'partial' | 'complete';

export type OcrCoverage = {
	revisionId: string;
	variant: string;
	status: OcrCoverageStatus;
	tool: string | null;
	toolVersion: string | null;
	preferred: boolean;
	pageCount: number;
};

export type OcrSummary = {
	state: 'available' | 'partial' | 'none';
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
