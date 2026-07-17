import { dataplane, type ArchiveFetcher } from './dataplane';
import { contentDisposition } from './filenames';
import { buildRangeResponse, quotedSha256Etag } from './range';

type RevisionContent = {
	id: string;
	sha256: string | null;
	bytes: number;
	originalFilename: string;
};

export async function streamRevisionContent(
	fetcher: ArchiveFetcher,
	actor: string,
	request: Request,
	revision: RevisionContent,
	method: 'GET' | 'HEAD'
): Promise<Response> {
	if (!revision.sha256) return new Response('revision has no blob', { status: 404 });
	const etag = quotedSha256Etag(revision.sha256);
	const range = buildRangeResponse(request.headers.get('range'), request.headers.get('if-range'), revision.bytes, etag);
	const headers = new Headers({
		'etag': etag,
		'accept-ranges': 'bytes',
		'cache-control': 'private, no-store',
		'content-disposition': contentDisposition(new URL(request.url).searchParams.get('disposition'), revision.originalFilename)
	});
	if (range.status === 416) {
		headers.set('content-range', range.contentRange);
		return new Response(null, { status: 416, headers });
	}
	const upstreamHeaders = new Headers();
	if (range.status === 206) upstreamHeaders.set('range', `bytes=${range.range.start}-${range.range.end}`);
	const upstream =
		method === 'HEAD'
			? await dataplane.headBlob(fetcher, actor, revision.sha256, upstreamHeaders)
			: await dataplane.getBlob(fetcher, actor, revision.sha256, upstreamHeaders);
	for (const name of ['content-type', 'last-modified']) {
		const value = upstream.headers.get(name);
		if (value) headers.set(name, value);
	}
	headers.set('content-length', String(range.contentLength));
	if (range.status === 206) headers.set('content-range', range.contentRange);
	return new Response(method === 'HEAD' ? null : upstream.body, { status: range.status, headers });
}
