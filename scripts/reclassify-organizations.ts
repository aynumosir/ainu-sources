#!/usr/bin/env bun
import { and, eq } from 'drizzle-orm';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../src/lib/server/db/schema';
import organizations from '../src/lib/data/organizations.json';
import type { Db } from './import/lib/entities';

/** Reclassify only the reviewed records, preserving source and observation provenance. */
export async function reclassifyOrganizations(db: Db, apply = false) {
 return db.transaction(async tx => {
  const plans = [];
  for (const org of organizations) {
   const [person] = await tx.select().from(schema.persons).where(eq(schema.persons.slug,org.personSlug));
   if (!person || person.name !== org.personName || !['active','reclassified'].includes(person.status)) throw new Error(`Organization identity changed: ${org.personSlug}`);
   const [existing] = await tx.select().from(schema.institutions).where(eq(schema.institutions.slug,org.institution.slug));
   if (existing && (existing.name !== org.institution.name || existing.status !== 'active')) throw new Error(`Organization target changed: ${org.institution.slug}`);
   const links = await tx.select().from(schema.sourcePersons).where(eq(schema.sourcePersons.personId,person.id));
   if (person.status === 'reclassified') {
    if (!existing || links.length) throw new Error(`Incomplete reclassification: ${person.slug}`);
    const carried = await tx.select().from(schema.sourceInstitutions).where(eq(schema.sourceInstitutions.institutionId,existing.id));
    if (org.sourceIds.some(id => !carried.some(l => l.sourceId === id && l.role === 'author'))) throw new Error(`Missing organization credits: ${person.slug}`);
    continue;
   }
   if (links.length !== org.sourceIds.length || links.some(l => l.role !== 'author' || !org.sourceIds.includes(l.sourceId))) throw new Error(`Organization credits changed: ${person.slug}`);
   if (await tx.select().from(schema.personSlugRedirects).where(eq(schema.personSlugRedirects.personId,person.id)).then(r=>r.length)) throw new Error(`Additional redirects need review: ${person.slug}`);
   const institutionId = existing?.id ?? `organization-${org.institution.slug}`;
   for (const link of links) {
    const duplicates = await tx.select().from(schema.sourceInstitutions).where(and(eq(schema.sourceInstitutions.institutionId,institutionId),eq(schema.sourceInstitutions.sourceId,link.sourceId),eq(schema.sourceInstitutions.role,link.role)));
    if (duplicates.length) throw new Error(`Existing organization credit needs review: ${link.id}`);
   }
   plans.push({org,person,links,institutionId,existing});
  }
  if (apply) for (const {org,person,links,institutionId,existing} of plans) {
   if (!existing) await tx.insert(schema.institutions).values({id:institutionId,...org.institution,status:'active',origin:'reviewed-reclassification'});
   for (const link of links) {
    const {personId,sortOrder,...provenance} = link;
    await tx.insert(schema.sourceInstitutions).values({...provenance,institutionId});
    await tx.delete(schema.sourcePersons).where(eq(schema.sourcePersons.id,link.id));
   }
   await tx.update(schema.persons).set({status:'reclassified'}).where(eq(schema.persons.id,person.id));
  }
  return {organizations:plans.length,credits:plans.reduce((n,p)=>n+p.links.length,0),applied:apply};
 });
}
if (import.meta.main) {
 const client=createClient({url:process.env.DATABASE_URL!,authToken:process.env.DATABASE_AUTH_TOKEN});
 try {console.log(JSON.stringify(await reclassifyOrganizations(drizzle(client,{schema}),process.argv.includes('--apply'))));}
 finally {client.close();}
}
