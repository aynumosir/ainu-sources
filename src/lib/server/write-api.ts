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

// SourceInput keys accepted from a request body, grouped by expected type.
// Persons / places / institutions / relations are intentionally excluded —
// they aren't editable through the app either.
const STRING_FIELDS = [
	'title', 'titleEn', 'titleAin', 'category', 'type', 'author', 'yearText',
	'yearCertainty', 'dialect', 'region', 'holdingInstitution', 'callNumber',
	'entryCountLabel', 'license', 'summary', 'notes', 'reliability'
] as const;
const NUMBER_FIELDS = ['yearStart', 'yearEnd', 'entryCount'] as const;
const STRING_ARRAY_FIELDS = ['languages', 'scripts', 'tagNames'] as const;

/** Keep only the string entries of an array; returns undefined if not an array. */
function asStringArray(v: unknown): string[] | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Normalize a links array to the { type, label, url } shape, dropping entries
 * that aren't objects with a non-empty string url. Returns undefined if `v` is
 * not an array. */
function asLinks(v: unknown): SourceInput['links'] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: NonNullable<SourceInput['links']> = [];
	for (const item of v) {
		if (!item || typeof item !== 'object') continue;
		const l = item as Record<string, unknown>;
		if (typeof l.url !== 'string' || !l.url.trim()) continue;
		out.push({
			type: typeof l.type === 'string' ? l.type : 'website',
			label: typeof l.label === 'string' ? l.label : null,
			url: l.url
		});
	}
	return out;
}

/** Copy only the SourceInput keys present in the body AND of the expected type,
 * so a PATCH merge leaves unspecified fields untouched and malformed values
 * never reach createSource/updateSource (the body is untrusted — the endpoint
 * is token-gated but public). Invalid values are skipped, not coerced. */
export function pickSourceInput(body: Record<string, unknown>): Partial<SourceInput> {
	const out: Record<string, unknown> = {};
	for (const k of STRING_FIELDS) if (typeof body[k] === 'string') out[k] = body[k];
	for (const k of NUMBER_FIELDS) if (typeof body[k] === 'number' && Number.isFinite(body[k])) out[k] = body[k];
	for (const k of STRING_ARRAY_FIELDS) {
		const arr = asStringArray(body[k]);
		if (arr !== undefined) out[k] = arr;
	}
	const links = asLinks(body.links);
	if (links !== undefined) out.links = links;
	return out as Partial<SourceInput>;
}

/** Re-check the invariants createSource/updateSource rely on, AFTER picking /
 * merging. Throws 400 on the first violation. Shared by the POST and PATCH
 * handlers so create and (merged) update enforce the same required fields. */
export function assertRequiredFields(input: Partial<SourceInput>): void {
	if (typeof input.title !== 'string' || !input.title.trim()) throw error(400, 'title is required (non-empty string)');
	if (typeof input.type !== 'string' || !input.type.trim()) throw error(400, 'type is required (non-empty string)');
	if (typeof input.category !== 'string' || !input.category.trim()) throw error(400, 'category is required (non-empty string)');
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
