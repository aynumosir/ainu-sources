import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '$env/dynamic/private';
import {
	corpusOrigin,
	getCorpusFetcher,
	getTextDocument,
	getTextDocuments,
	getTextSources,
	normalizeDisplayText,
	resetTextSourcesMemo,
	type CorpusFetcher
} from './corpus';

const envelope = (data: unknown) => new Response(JSON.stringify({ api_version: '1', data }), { status: 200 });

function fetcherOf(handler: (url: URL) => Response | Promise<Response>): CorpusFetcher & { calls: URL[] } {
	const calls: URL[] = [];
	return {
		calls,
		async fetch(input) {
			const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
			calls.push(url);
			return handler(url);
		}
	};
}

beforeEach(() => {
	resetTextSourcesMemo();
	delete env.CORPUS_ORIGIN;
});
afterEach(() => vi.restoreAllMocks());

describe('corpusOrigin', () => {
	it('defaults to corpus.aynu.org and honours CORPUS_ORIGIN without a trailing slash', () => {
		expect(corpusOrigin()).toBe('https://corpus.aynu.org');
		env.CORPUS_ORIGIN = 'http://localhost:8787/';
		expect(corpusOrigin()).toBe('http://localhost:8787');
	});
});

describe('getCorpusFetcher', () => {
	it('prefers the CORPUS service binding', async () => {
		const bound = fetcherOf(() => envelope([]));
		expect(getCorpusFetcher({ CORPUS: bound })).toBe(bound);
	});
	it('falls back to global fetch', () => {
		expect(getCorpusFetcher(undefined)).not.toBeUndefined();
	});
	it('fetches an explicit CORPUS_ORIGIN directly even when a binding exists', () => {
		env.CORPUS_ORIGIN = 'http://localhost:8790';
		const bound = fetcherOf(() => envelope([]));
		expect(getCorpusFetcher({ CORPUS: bound })).not.toBe(bound);
	});
});

describe('normalizeDisplayText', () => {
	it('composes to NFC and collapses spacing', () => {
		expect(normalizeDisplayText('néa  kotan　ta ')).toBe('néa kotan ta');
	});
});

describe('getTextSources', () => {
	it('maps the list by slug and memoises it', async () => {
		const fetcher = fetcherOf(() =>
			envelope([{ source_slug: 'asai-take-folktales', documents: 54, sentences: 3852, translated: 3852, text_layer: 'modern-orthography-latn@1', text_layer_status: 'provisional' }])
		);
		const first = await getTextSources(fetcher, 1000);
		expect(first.get('asai-take-folktales')?.documents).toBe(54);
		expect(fetcher.calls[0].pathname).toBe('/v1/text/sources');
		await getTextSources(fetcher, 2000);
		expect(fetcher.calls).toHaveLength(1);
		await getTextSources(fetcher, 1000 + 11 * 60 * 1000);
		expect(fetcher.calls).toHaveLength(2);
	});

	it('keeps the last good list when the corpus is unreachable and waits before retrying', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		let fail = false;
		const fetcher = fetcherOf(() => {
			if (fail) throw new Error('offline');
			return envelope([{ source_slug: 'x', documents: 1, sentences: 1, translated: 0, text_layer: null, text_layer_status: null }]);
		});
		await getTextSources(fetcher, 0);
		fail = true;
		const t = 20 * 60 * 1000;
		expect((await getTextSources(fetcher, t)).has('x')).toBe(true);
		expect(fetcher.calls).toHaveLength(2);
		await getTextSources(fetcher, t + 10_000);
		expect(fetcher.calls).toHaveLength(2);
		await getTextSources(fetcher, t + 40_000);
		expect(fetcher.calls).toHaveLength(3);
	});

	it('treats a malformed 200 as unreachable', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const junk = fetcherOf(() => new Response(JSON.stringify({ api_version: '1', data: { nope: true } })));
		expect((await getTextSources(junk)).size).toBe(0);
		expect(await getTextDocuments(junk, 'x')).toEqual({ ok: false, reason: 'unreachable' });
		expect(await getTextDocument(junk, 'x', 'y')).toEqual({ ok: false, reason: 'unreachable' });
		const notJson = fetcherOf(() => new Response('<html>', { status: 200 }));
		expect(await getTextDocuments(notJson, 'x')).toEqual({ ok: false, reason: 'unreachable' });
	});

	it('is empty when the API answers with an error envelope', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const fetcher = fetcherOf(() => new Response(JSON.stringify({ api_version: '1', error: { code: 'internal', message: 'x' } })));
		expect((await getTextSources(fetcher)).size).toBe(0);
	});
});

describe('getTextDocuments', () => {
	it('passes the slug and returns the list', async () => {
		const fetcher = fetcherOf(() => envelope([{ key: 'aa-asai/001', ord: 0, title: 'さらわれた娘', sentences: 19, translated: 19, text_layer: null, text_layer_status: null, author: null, dialect: null, uri: null }]));
		const docs = await getTextDocuments(fetcher, 'asai-take-folktales');
		expect(docs.ok && docs.data[0].key).toBe('aa-asai/001');
		expect(fetcher.calls[0].searchParams.get('source')).toBe('asai-take-folktales');
	});
	it('reports a network failure as unreachable, and a 5xx too', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const offline = fetcherOf(() => { throw new Error('offline'); });
		expect(await getTextDocuments(offline, 'x')).toEqual({ ok: false, reason: 'unreachable' });
		const broken = fetcherOf(() => new Response('', { status: 502 }));
		expect(await getTextDocuments(broken, 'x')).toEqual({ ok: false, reason: 'unreachable' });
	});
});

describe('getTextDocument', () => {
	it('normalises sentence text and forwards paging', async () => {
		const fetcher = fetcherOf(() =>
			envelope({
				document: { key: 'aa-asai/001', ord: 0, title: 't', sentences: 2, translated: 2, text_layer: 'modern-orthography-latn@1', text_layer_status: 'provisional', author: null, dialect: null, uri: null },
				prev: null,
				next: null,
				total: 2,
				offset: 1,
				limit: 1,
				sentences: [{ id: 'aa-asai/001#1', index: 1, text: 'maas  pontara', source_text: 'maas　pontara', text_layer: null, text_layer_status: null, translation: null, dialect: null, author: null, uri: null }]
			})
		);
		const r = await getTextDocument(fetcher, 'asai-take-folktales', 'aa-asai/001', { offset: 1, limit: 1 });
		const page = r.ok ? r.data : null;
		expect(page?.sentences[0].text).toBe('maas pontara');
		expect(page?.sentences[0].source_text).toBe('maas pontara');
		expect(fetcher.calls[0].searchParams.get('key')).toBe('aa-asai/001');
		expect(fetcher.calls[0].searchParams.get('offset')).toBe('1');
		expect(fetcher.calls[0].searchParams.get('limit')).toBe('1');
	});
	it('is absent for a 404', async () => {
		const fetcher = fetcherOf(() => new Response('', { status: 404 }));
		expect(await getTextDocument(fetcher, 'x', 'y')).toEqual({ ok: false, reason: 'absent' });
	});
});
