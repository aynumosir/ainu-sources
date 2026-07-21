import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { contentDisposition } from '$lib/server/archive/filenames';
import { authorizeContent } from '$lib/server/archive/gateway';
import { archivePrincipal, archiveRouteDb, throwArchiveError } from '$lib/server/archive/route';
import { buildRevisionTextExport } from '$lib/server/archive/workspace';

function exportFormat(value: string | null): 'txt' | 'jsonl' {
	if (value === 'txt' || value === 'jsonl') return value;
	throw error(400, 'format must be txt or jsonl');
}

function exportVariant(value: string | null): 'working' | 'machine' | 'approved' {
	if (value === 'working' || value === 'machine' || value === 'approved') return value;
	throw error(400, 'variant must be working, machine, or approved');
}

export const GET: RequestHandler = async ({ request, params, url, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archivePrincipal(request, 'archive_reader', db);
	try {
		const generated = await buildRevisionTextExport(db, params.id, {
			format: exportFormat(url.searchParams.get('format')),
			variant: exportVariant(url.searchParams.get('variant'))
		});
		await authorizeContent(db, {
			principal,
			revisionId: params.id,
			useKind: 'export',
			requestedBytes: new TextEncoder().encode(generated.body).byteLength
		});
		return new Response(generated.body, {
			headers: {
				'Content-Type': generated.contentType,
				'Content-Disposition': contentDisposition('attachment', generated.filename),
				'Cache-Control': 'private, no-store'
			}
		});
	} catch (e) {
		throwArchiveError(e);
	}
};
