import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authorizeContent } from '$lib/server/archive/gateway';
import {
	archiveMutationPrincipal,
	archiveRouteDb,
	readJsonObject,
	throwArchiveError
} from '$lib/server/archive/route';
import { savePageEdit, type PageEditBase } from '$lib/server/archive/workspace';

function pageNumber(value: string): number {
	const page = Number(value);
	if (!Number.isSafeInteger(page) || page < 0) throw error(400, 'invalid page');
	return page;
}

function parseBase(value: unknown): PageEditBase {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw error(400, 'base is required');
	const base = value as Record<string, unknown>;
	if (base.kind === 'edit' && typeof base.edit_id === 'string' && base.edit_id) {
		return { kind: 'edit', editId: base.edit_id };
	}
	if (base.kind === 'variant' && typeof base.variant === 'string' && base.variant.trim()) {
		return { kind: 'variant', variant: base.variant.trim() };
	}
	throw error(400, 'invalid base');
}

export const PUT: RequestHandler = async ({ request, params, locals }) => {
	const db = archiveRouteDb(locals);
	const principal = await archiveMutationPrincipal(request, 'archive_contributor', db);
	try {
		await authorizeContent(db, {
			principal,
			revisionId: params.id,
			useKind: 'text',
			requestedBytes: 0,
			rateUnits: 1
		});
		const body = await readJsonObject(request);
		if (typeof body.text !== 'string') throw error(400, 'text is required');
		if (body.note != null && typeof body.note !== 'string') throw error(400, 'note must be a string');
		return json(
			await savePageEdit(db, params.id, pageNumber(params.page), principal, {
				text: body.text,
				base: parseBase(body.base),
				note: body.note as string | undefined
			}),
			{ status: 201 }
		);
	} catch (e) {
		throwArchiveError(e);
	}
};
