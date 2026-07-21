export type ArchiveUsage = {
	date: string;
	bytesUsed: number;
	dailyByteLimit: number;
	resetAt: string;
	activeStreams: number;
	concurrentStreamLimit: number;
} | null;

export const archiveUsage = $state({
	value: null as ArchiveUsage
});

export function seedArchiveUsage(usage: ArchiveUsage): void {
	archiveUsage.value = usage;
}
