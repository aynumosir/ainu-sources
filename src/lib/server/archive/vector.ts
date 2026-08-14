/**
 * Dense-vector retrieval over the OCR chunks, behind a narrow interface so
 * search code and tests carry no Cloudflare types. The production backend
 * embeds with Workers AI bge-m3 and queries a Vectorize index whose vector
 * ids are chunk ids; a vector belonging to a superseded ingest generation
 * simply stops matching any active chunk row, so stale vectors fall out of
 * results without deletion.
 */
export type ArchiveVectorBackend = {
	embedQuery(text: string): Promise<number[]>;
	query(vector: number[], topK: number): Promise<Array<{ id: string; score: number }>>;
};

export const ARCHIVE_VECTOR_MODEL = '@cf/baai/bge-m3';
export const ARCHIVE_VECTOR_INDEX = 'archive-ocr';

type AiBinding = { run(model: string, input: { text: string[] }): Promise<unknown> };
type VectorizeBinding = {
	query(
		vector: number[],
		options: { topK: number; returnValues?: boolean; returnMetadata?: 'none' | 'indexed' | 'all' }
	): Promise<{ matches: Array<{ id: string; score: number }> }>;
};

export function archiveVectorBackend(platform: App.Platform | undefined): ArchiveVectorBackend | undefined {
	const env = platform?.env as { AI?: AiBinding; ARCHIVE_VECTORS?: VectorizeBinding } | undefined;
	const ai = env?.AI;
	const index = env?.ARCHIVE_VECTORS;
	if (!ai || !index) return undefined;
	return {
		async embedQuery(text: string): Promise<number[]> {
			const response = (await ai.run(ARCHIVE_VECTOR_MODEL, { text: [text] })) as { data?: number[][] };
			const vector = response?.data?.[0];
			if (!vector?.length) throw new Error('query embedding returned no vector');
			return vector;
		},
		async query(vector: number[], topK: number): Promise<Array<{ id: string; score: number }>> {
			const result = await index.query(vector, { topK, returnValues: false, returnMetadata: 'none' });
			return result.matches.map((match) => ({ id: match.id, score: match.score }));
		}
	};
}
