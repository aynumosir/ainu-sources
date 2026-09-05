#!/usr/bin/env bun
import { eq } from 'drizzle-orm';
import { persons, sources, sourcePersons } from '../src/lib/server/db/schema';
import { type Db } from './import/lib/entities';
import { parseImporterCli } from './import/lib/run';
import manifest from './data/person-attribution-review.json';

type Person = typeof persons.$inferInsert;
type Change = { id: string; sourceSlug: string; sourceId: string; fromPersonId: string; toSlug: string | null; role: string; toRole?: string; sortOrder?: number; expectedAuthor?: string };
type Addition = { id: string; sourceSlug: string; sourceId: string; personSlug: string; role: string; sortOrder: number };
export type AttributionReview = { newPersons: Person[]; changes: Change[]; additions: Addition[] };

/** Apply source-specific identity decisions atomically, preserving metadata on moved edges. */
export async function applyAttributions(db: Db, dryRun = false, review: AttributionReview = manifest) {
 return db.transaction(async (tx) => {
  const people = await tx.select().from(persons);
  const books = await tx.select({ id: sources.id, slug: sources.slug, author: sources.author }).from(sources);
  const links = await tx.select().from(sourcePersons);
  const bySlug = new Map(people.map(p => [p.slug, p]));
  const pendingPeople: Person[] = [];
  const resolve = (slug: string): string => {
   const existing = bySlug.get(slug);
   if (existing) {
    if (existing.status !== 'active') throw new Error(`Attribution target merged: ${slug}`);
    const definition = review.newPersons.find(p => p.slug === slug);
    if (definition && (existing.id !== definition.id || existing.name !== definition.name))
     throw new Error(`Attribution target identity changed: ${slug}`);
    return existing.id;
   }
   const definition = review.newPersons.find(p => p.slug === slug);
   if (!definition?.id) throw new Error(`Missing attribution target: ${slug}`);
   if (!pendingPeople.some(p => p.slug === slug)) pendingPeople.push(definition);
   return definition.id;
  };
  const changes: { id: string; personId: string | null; role: string; sortOrder?: number }[] = [];
  const additions: (typeof sourcePersons.$inferInsert)[] = [];
  const checkSource = (slug: string, id: string) => {
   const book = books.find(s => s.slug === slug);
   if (!book || book.id !== id) throw new Error(`Attribution source changed: ${slug}`);
   return book;
  };
  for (const change of review.changes) {
   const book = checkSource(change.sourceSlug, change.sourceId);
   if (change.expectedAuthor && book.author !== change.expectedAuthor)
    throw new Error(`Attribution author changed: ${change.sourceSlug}`);
   const target = change.toSlug ? resolve(change.toSlug) : null;
   const role = change.toRole ?? change.role;
   const original = links.find(l => l.id === change.id);
   if (original && (original.sourceId !== change.sourceId ||
    !((original.personId === change.fromPersonId && original.role === change.role) ||
      (original.personId === target && original.role === role))))
    throw new Error(`Attribution edge changed: ${change.id}`);
   // Match the reviewed tuple too, so a later harvest cannot resurrect the error with a new ID.
   for (const link of links.filter(l => l.sourceId === change.sourceId && l.personId === change.fromPersonId && l.role === change.role)) {
    if (link.personId !== target || link.role !== role || (change.sortOrder !== undefined && link.sortOrder !== change.sortOrder))
     changes.push({ id: link.id, personId: target && links.some(l => l.id !== link.id && l.sourceId === link.sourceId && l.personId === target && l.role === role) ? null : target, role, sortOrder: change.sortOrder });
   }
  }
  for (const addition of review.additions) {
   checkSource(addition.sourceSlug, addition.sourceId);
   const personId = resolve(addition.personSlug);
   if (!links.some(l => l.sourceId === addition.sourceId && l.personId === personId && l.role === addition.role))
    additions.push({ id: addition.id, sourceId: addition.sourceId, personId, role: addition.role, sortOrder: addition.sortOrder, origin: 'reviewed-person-attributions-2026-09-05' });
  }
  if (!dryRun) {
   for (const person of pendingPeople) {
    const { id, slug, name, nameEn, birthYear, deathYear, bio } = person;
    await tx.insert(persons).values({ id, slug, name, nameEn, birthYear, deathYear, bio, origin: 'reviewed-person-attributions-2026-09-05' });
   }
   for (const change of changes) {
    if (change.personId === null) await tx.delete(sourcePersons).where(eq(sourcePersons.id, change.id));
    else await tx.update(sourcePersons).set({ personId: change.personId, role: change.role, ...(change.sortOrder === undefined ? {} : { sortOrder: change.sortOrder }) }).where(eq(sourcePersons.id, change.id));
   }
   for (const addition of additions) await tx.insert(sourcePersons).values(addition);
  }
  return { persons: pendingPeople.length, changes: changes.length, additions: additions.length };
 });
}

if (import.meta.main) {
 const { db, opts } = parseImporterCli();
 console.log({ dryRun: Boolean(opts.dryRun), ...await applyAttributions(db, opts.dryRun) });
}
