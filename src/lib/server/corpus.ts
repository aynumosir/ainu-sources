/**
 * Client for the corpus API (corpus.aynu.org), the ecosystem's single corpus
 * query surface. On Cloudflare the CORPUS service binding reaches the Worker
 * directly; elsewhere (local dev, tests) the public origin is fetched.
 *
 * Every call fails soft: the catalogue page still renders when the corpus is
 * unreachable, only without its text. Responses are the API's envelope
 * `{ api_version, data }` / `{ api_version, error }`.
 */
import { env } from '$env/dynamic/private';

export type CorpusFetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

export const CORPUS_PUBLIC_ORIGIN = 'https://corpus.aynu.org';
const REQUEST_TIMEOUT_MS = 8000;

export interface TextSourceSummary {
	source_slug: string;
	documents: number;
	sentences: number;
	translated: number;
	text_layer: string | null;
	text_layer_status: string | null;
}

export interface TextDocument {
	key: string;
	ord: number;
	title: string | null;
	sentences: number;
	translated: number;
	text_layer: string | null;
	text_layer_status: string | null;
	uri: string | null;
}

export interface TextSentence {
	id: string;
	index: number;
	text: string;
	source_text: string | null;
	text_layer: string | null;
	text_layer_status: string | null;
	translation: string | null;
	dialect: string | null;
	author: string | null;
	uri: string | null;
}

export interface TextDocumentPage {
	document: TextDocument;
	prev: Pick<TextDocument, 'key' | 'title'> | null;
	next: Pick<TextDocument, 'key' | 'title'> | null;
	sentences: TextSentence[];
	total: number;
	offset: number;
	limit: number;
}

type Envelope<T> = { api_version: string; data: T } | { api_version: string; error: { code: string; message: string } };

/** The corpus origin for public fetches: CORPUS_ORIGIN when set, else corpus.aynu.org. */
export function corpusOrigin(): string {
	return (env.CORPUS_ORIGIN || CORPUS_PUBLIC_ORIGIN).replace(/\/+$/u, '');
}

/**
 * Resolve how to reach the corpus. An explicit CORPUS_ORIGIN is fetched
 * directly (local development runs the corpus API on its own port, and the
 * emulated CORPUS binding there has no Worker behind it); otherwise the CORPUS
 * service binding when the platform provides one; otherwise the public origin.
 */
export function getCorpusFetcher(platformEnv: { CORPUS?: CorpusFetcher } | undefined): CorpusFetcher {
	const direct: CorpusFetcher = { fetch: (input, init) => fetch(input, init) };
	if (env.CORPUS_ORIGIN) return direct;
	return platformEnv?.CORPUS ?? direct;
}

async function callCorpus<T>(fetcher: CorpusFetcher, path: string, query: Record<string, string | number>): Promise<T | null> {
	const url = new URL(path, corpusOrigin());
	for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
	try {
		const res = await fetcher.fetch(url.toString(), {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (res.status === 404) return null;
		if (!res.ok) {
			console.warn(`[corpus] ${path} answered ${res.status}`);
			return null;
		}
		const body = (await res.json()) as Envelope<T>;
		if ('error' in body) {
			console.warn(`[corpus] ${path}: ${body.error.code} ${body.error.message}`);
			return null;
		}
		return body.data;
	} catch (e) {
		console.warn(`[corpus] ${path} failed:`, e instanceof Error ? e.message : e);
		return null;
	}
}

/** Text normalisation for display: one Unicode form, one kind of space. */
export function normalizeDisplayText(text: string): string {
	return text.normalize('NFC').replace(/[ \t 　]+/gu, ' ').trim();
}

function normalizeSentence(s: TextSentence): TextSentence {
	return {
		...s,
		text: normalizeDisplayText(s.text),
		source_text: s.source_text == null ? null : normalizeDisplayText(s.source_text),
		translation: s.translation == null ? null : normalizeDisplayText(s.translation)
	};
}

const SOURCES_TTL_MS = 10 * 60 * 1000;
let sourcesMemo: { at: number; value: Map<string, TextSourceSummary> } | null = null;

/**
 * Which sources have readable text, keyed by catalogue slug. One small list
 * for the whole corpus, so it is memoised per isolate for ten minutes.
 */
export async function getTextSources(fetcher: CorpusFetcher, now = Date.now()): Promise<Map<string, TextSourceSummary>> {
	if (sourcesMemo && now - sourcesMemo.at < SOURCES_TTL_MS) return sourcesMemo.value;
	const list = await callCorpus<TextSourceSummary[]>(fetcher, '/v1/text/sources', {});
	if (!list) return sourcesMemo?.value ?? new Map();
	const value = new Map(list.map((s) => [s.source_slug, s]));
	sourcesMemo = { at: now, value };
	return value;
}

/** Test seam: forget the memoised source list. */
export function resetTextSourcesMemo(): void {
	sourcesMemo = null;
}

/** The documents of one source in reading order. Empty when it has no text. */
export async function getTextDocuments(fetcher: CorpusFetcher, slug: string): Promise<TextDocument[]> {
	return (await callCorpus<TextDocument[]>(fetcher, '/v1/text/documents', { source: slug })) ?? [];
}

/** One page of a document's sentences, or null when the document does not exist. */
export async function getTextDocument(
	fetcher: CorpusFetcher,
	slug: string,
	key: string,
	opts: { offset?: number; limit?: number } = {}
): Promise<TextDocumentPage | null> {
	const page = await callCorpus<TextDocumentPage>(fetcher, '/v1/text/document', {
		source: slug,
		key,
		...(opts.offset ? { offset: opts.offset } : {}),
		...(opts.limit ? { limit: opts.limit } : {})
	});
	if (!page) return null;
	return { ...page, sentences: page.sentences.map(normalizeSentence) };
}
