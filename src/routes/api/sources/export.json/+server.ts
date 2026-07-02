/**
 * GET /api/sources/export.json — bulk machine-readable export of the whole
 * source catalogue (no pagination), ordered by slug. One compact record per
 * source; consumers (ainu-dictionaries CI, corpus pipelines, client libraries)
 * download this once and validate citation slugs offline.
 *
 * Lifecycle: exports the publicly-resolvable statuses — 'active', 'merged'
 * (with `merged_into_slug` pointing at the winning source's slug, so old slugs
 * stay validatable) and 'deprecated'. Rows the public site never surfaces
 * (candidate / hidden / soft_deleted) are excluded, matching visibility.ts.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { asc, eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { db } from '$lib/server/db';
import { sources } from '$lib/server/db/schema';

const HEADERS = {
	'access-control-allow-origin': '*',
	'cache-control': 'public, max-age=3600, s-maxage=3600'
} as const;

/** Statuses whose slugs remain valid citation targets (see visibility.ts). */
const EXPORT_STATUSES = ['active', 'merged', 'deprecated'];

export const GET: RequestHandler = async () => {
	const mergeTarget = alias(sources, 'merge_target');
	const rows = await db
		.select({
			slug: sources.slug,
			title: sources.title,
			titleEn: sources.titleEn,
			type: sources.type,
			category: sources.category,
			author: sources.author,
			yearText: sources.yearText,
			yearStart: sources.yearStart,
			yearEnd: sources.yearEnd,
			dialect: sources.dialect,
			region: sources.region,
			provenanceRepo: sources.provenanceRepo,
			provenancePath: sources.provenancePath,
			externalIds: sources.externalIds,
			status: sources.status,
			mergedIntoSlug: mergeTarget.slug
		})
		.from(sources)
		.leftJoin(mergeTarget, eq(sources.mergedIntoSourceId, mergeTarget.id))
		.where(inArray(sources.status, EXPORT_STATUSES))
		.orderBy(asc(sources.slug));

	return json(
		rows.map((r) => ({
			slug: r.slug,
			title: r.title,
			title_en: r.titleEn,
			type: r.type,
			category: r.category,
			author: r.author,
			year_text: r.yearText,
			year_start: r.yearStart,
			year_end: r.yearEnd,
			dialect: r.dialect,
			region: r.region,
			provenance_repo: r.provenanceRepo,
			provenance_path: r.provenancePath,
			external_ids: r.externalIds,
			status: r.status,
			merged_into_slug: r.mergedIntoSlug
		})),
		{ headers: HEADERS }
	);
};
