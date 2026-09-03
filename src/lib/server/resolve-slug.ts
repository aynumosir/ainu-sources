// ---------------------------------------------------------------------------
// Slug-rename fallthrough (スラッグ転送の解決) — the read side of the
// "old slugs never break" promise.
//
// When a public slug lookup finds no source, the route asks `resolveSlug()`
// whether the slug was RENAMED (a `slug_redirects` row). On a hit the route
// answers with a permanent 301 to the same route at the CURRENT slug — one
// query, no chains: redirects always store the source id, so however many
// times a source is renamed, every retired slug resolves to today's slug in
// a single hop. This is deliberately separate from the merge redirect
// (`getMergeRedirectTarget`, a 302 between two DIFFERENT sources); a rename
// is the SAME source under a new name, hence permanent.
// ---------------------------------------------------------------------------
import { eq, inArray, and } from 'drizzle-orm';
import { personSlugRedirects, persons, slugRedirects, sources } from './db/schema';
import { slugContentError } from './slug-content';
import type { Db } from './merge/types';

/**
 * Statuses whose current slug is worth redirecting to: 'active' renders, and a
 * 'merged' loser itself 302s on to its winner. Anything the public site would
 * 404 anyway (candidate / hidden / soft_deleted / deprecated) returns
 * undefined so the caller 404s directly instead of bouncing through a 301.
 */
const REDIRECTABLE_STATUSES = ['active', 'merged'];

/**
 * If `slug` is a retired (renamed) slug, return the source's CURRENT slug so
 * the caller can 301 to it; otherwise undefined (the caller 404s / falls
 * through). Never returns `slug` itself.
 */
export async function resolveSlug(db: Db, slug: string): Promise<string | undefined> {
	const [row] = await db
		.select({ slug: sources.slug })
		.from(slugRedirects)
		.innerJoin(sources, eq(slugRedirects.sourceId, sources.id))
		.where(and(eq(slugRedirects.oldSlug, slug), inArray(sources.status, REDIRECTABLE_STATUSES)))
		.limit(1);
	if (!row || row.slug === slug) return undefined;
	return row.slug;
}

// ---------------------------------------------------------------------------
// Explicit-slug minting guard — the WRITE side of the same promise.
// ---------------------------------------------------------------------------

/** Shape of a mintable slug (same rule scripts/apply-reslug.ts enforces). */
export const EXPLICIT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;

/**
 * Why an explicit slug may NOT be minted for a NEW source, or null when it is
 * free. Four checks: the shape rule, whether the slug names anything at all,
 * a collision with ANY existing source (`sources.slug` is UNIQUE across every
 * status), and a collision with a retired slug in `slug_redirects` — re-minting
 * a retired slug would shadow its permanent 301 and break the "old slugs never
 * break" promise above. Callers turn the returned message into a 400 / form
 * error; the UNIQUE constraint on `sources.slug` remains the last-resort guard.
 */
export async function explicitSlugError(db: Db, slug: string): Promise<string | null> {
	if (!EXPLICIT_SLUG_RE.test(slug))
		return `slug must match ${EXPLICIT_SLUG_RE} (lowercase letters, digits and hyphens; 2-60 chars; starts alphanumeric)`;
	const empty = slugContentError(slug);
	if (empty) return empty;
	const [src] = await db
		.select({ id: sources.id })
		.from(sources)
		.where(eq(sources.slug, slug))
		.limit(1);
	if (src) return `slug "${slug}" is already taken by an existing source`;
	const [red] = await db
		.select({ oldSlug: slugRedirects.oldSlug })
		.from(slugRedirects)
		.where(eq(slugRedirects.oldSlug, slug))
		.limit(1);
	if (red) return `slug "${slug}" is retired and permanently redirects to another slug`;
	return null;
}

// ---------------------------------------------------------------------------
// People — the same promise for `/people/<slug>`.
// ---------------------------------------------------------------------------

/**
 * The current slug behind a person slug that no longer renders: a slug retired
 * by a rename or merge (`person_slug_redirects`), or the slug of a merged row
 * (`persons.status = 'merged'` + `merged_into_person_id`). Both hop once to an
 * active person. Undefined when the slug is unknown, or already current.
 */
export async function resolvePersonSlug(db: Db, slug: string): Promise<string | undefined> {
	const [red] = await db
		.select({ slug: persons.slug, status: persons.status })
		.from(personSlugRedirects)
		.innerJoin(persons, eq(personSlugRedirects.personId, persons.id))
		.where(eq(personSlugRedirects.oldSlug, slug))
		.limit(1);
	if (red && red.status === 'active' && red.slug !== slug) return red.slug;
	const [row] = await db
		.select({ status: persons.status, into: persons.mergedIntoPersonId })
		.from(persons)
		.where(eq(persons.slug, slug))
		.limit(1);
	if (!row || row.status !== 'merged' || !row.into) return undefined;
	const [winner] = await db
		.select({ slug: persons.slug })
		.from(persons)
		.where(and(eq(persons.id, row.into), eq(persons.status, 'active')))
		.limit(1);
	return winner && winner.slug !== slug ? winner.slug : undefined;
}

/**
 * Why a slug may NOT be minted for a NEW person, or null when it is free: a
 * live or merged person already holds it, or a redirect retired it.
 */
export async function personSlugError(db: Db, slug: string): Promise<string | null> {
	const [p] = await db.select({ id: persons.id }).from(persons).where(eq(persons.slug, slug)).limit(1);
	if (p) return `slug "${slug}" is already taken by an existing person`;
	const [red] = await db
		.select({ oldSlug: personSlugRedirects.oldSlug })
		.from(personSlugRedirects)
		.where(eq(personSlugRedirects.oldSlug, slug))
		.limit(1);
	if (red) return `slug "${slug}" is retired and permanently redirects to another person`;
	return null;
}
