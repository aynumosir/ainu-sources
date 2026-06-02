/**
 * Shared helpers for the source write API (POST /api/sources, PATCH
 * /api/sources/[slug]).
 *
 * These endpoints are driven by the Ainu MCP server over a Cloudflare service
 * binding, which carries no better-auth session cookie — so instead of the
 * interactive login the UI form actions use, they are authorized by a shared
 * `SOURCES_WRITE_TOKEN` bearer secret (set on both this Worker and the MCP
 * Worker). The MCP additionally gates these tools to aynumosir org members.
 */
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { SourceInput, EditUser } from './queries';
import type { SourceDetail } from '$lib/types';

/** Constant-time string compare (avoids leaking the token via timing). */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

/** Authorize a write request by the shared bearer secret, else throw. */
export function requireWriteToken(request: Request): void {
	const expected = env.SOURCES_WRITE_TOKEN;
	if (!expected) throw error(503, 'write API is not configured (SOURCES_WRITE_TOKEN unset)');
	const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') ?? '');
	if (!m || !safeEqual(m[1], expected)) throw error(401, 'invalid or missing write token');
}

// SourceInput keys accepted from a request body. Persons / places /
// institutions / relations are intentionally excluded — they aren't editable
// through the app either.
const FIELDS = [
	'title', 'titleEn', 'titleAin', 'category', 'type', 'author', 'yearText',
	'yearStart', 'yearEnd', 'yearCertainty', 'dialect', 'region', 'languages',
	'scripts', 'holdingInstitution', 'callNumber', 'entryCount', 'entryCountLabel',
	'license', 'summary', 'notes', 'reliability', 'links', 'tagNames'
] as const;

/** Copy only the SourceInput keys actually present in the body, so a PATCH
 * merge leaves unspecified fields untouched. */
export function pickSourceInput(body: Record<string, unknown>): Partial<SourceInput> {
	const out: Record<string, unknown> = {};
	for (const k of FIELDS) if (k in body) out[k] = body[k];
	return out as Partial<SourceInput>;
}

/** The edit attribution (who made the change), recorded on the revision. */
export function pickUser(body: Record<string, unknown>): EditUser {
	const u = (body.user ?? {}) as Record<string, unknown>;
	return {
		id: typeof u.id === 'string' ? u.id : undefined,
		name: typeof u.name === 'string' ? u.name : undefined
	};
}

export function revisionSummaryOf(body: Record<string, unknown>): string | undefined {
	return typeof body.revisionSummary === 'string' ? body.revisionSummary : undefined;
}

/** Reconstruct an editable SourceInput from a loaded detail — the basis a PATCH
 * merges the provided fields onto (so omitted fields keep their current value).
 * Mirrors how the edit form pre-fills from the current record. */
export function detailToInput(d: SourceDetail): SourceInput {
	const s = d.source;
	return {
		title: s.title,
		titleEn: s.titleEn,
		titleAin: s.titleAin,
		category: s.category,
		type: s.type,
		author: s.author,
		yearText: s.yearText,
		yearStart: s.yearStart,
		yearEnd: s.yearEnd,
		yearCertainty: s.yearCertainty,
		dialect: s.dialect,
		region: s.region,
		languages: s.languages ?? [],
		scripts: s.scripts ?? [],
		holdingInstitution: s.holdingInstitution,
		callNumber: s.callNumber,
		entryCount: s.entryCount,
		entryCountLabel: s.entryCountLabel,
		license: s.license,
		summary: s.summary,
		notes: s.notes,
		reliability: s.reliability,
		links: d.links.map((l) => ({ type: l.type, label: l.label, url: l.url })),
		tagNames: d.tags.map((t) => t.name)
	};
}
