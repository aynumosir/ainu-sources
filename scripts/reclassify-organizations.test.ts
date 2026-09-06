import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {createClient} from '@libsql/client';
import {drizzle} from 'drizzle-orm/libsql';
import {migrate} from 'drizzle-orm/libsql/migrator';
import {fileURLToPath} from 'node:url';
import {eq} from 'drizzle-orm';
import * as schema from '../src/lib/server/db/schema';
import organizations from '../src/lib/data/organizations.json';
import {reclassifyOrganizations} from './reclassify-organizations';
import {addPersons,addPersonsGated} from './import/lib/entities';
it('moves organizational credits atomically, preserves provenance and prevents reimport as people',async()=>{
 const scratch=mkdtempSync(join(tmpdir(),'organizations-test-'));
 const client=createClient({url:`file:${join(scratch,'test.db')}`});
 try {
  const db=drizzle(client,{schema});await migrate(db,{migrationsFolder:fileURLToPath(new URL('../drizzle',import.meta.url))});
  for(const org of organizations){
   await db.insert(schema.persons).values({id:org.personSlug,slug:org.personSlug,name:org.personName});
   for(const id of org.sourceIds){
    await db.insert(schema.sources).values({id,slug:id,title:'Source',type:'book'});
    await db.insert(schema.sourcePersons).values({id,sourceId:id,personId:org.personSlug,role:'author',origin:'academic',confidence:0.8});
   }
  }
  expect(await reclassifyOrganizations(db)).toEqual({organizations:3,credits:6,applied:false});
  expect((await db.select().from(schema.sourcePersons)).length).toBe(6);
  const last=organizations.at(-1)!;
  await db.update(schema.persons).set({name:'Different identity'}).where(eq(schema.persons.slug,last.personSlug));
  await expect(reclassifyOrganizations(db,true)).rejects.toThrow('identity changed');
  expect(await db.select().from(schema.institutions)).toHaveLength(0);
  await db.update(schema.persons).set({name:last.personName}).where(eq(schema.persons.slug,last.personSlug));
  expect(await reclassifyOrganizations(db,true)).toEqual({organizations:3,credits:6,applied:true});
  const moved=await db.select().from(schema.sourceInstitutions);
  expect(moved).toHaveLength(6);expect(moved.every(l=>l.role==='author'&&l.origin==='academic'&&l.confidence===0.8)).toBe(true);
  expect(await db.select().from(schema.sourcePersons)).toHaveLength(0);
  expect((await reclassifyOrganizations(db,true)).organizations).toBe(0);
  for(const org of organizations){
   await addPersons(db,org.sourceIds[0],org.personName,{origin:'academic'});
   await addPersonsGated(db,org.sourceIds[1],[org.institution.name],new Set(),{origin:'academic'});
  }
  expect(await db.select().from(schema.sourcePersons)).toHaveLength(0);
  expect(await db.select().from(schema.sourceInstitutions)).toEqual(moved);
  expect(await db.select().from(schema.persons)).toHaveLength(3);
  expect((await client.execute('PRAGMA foreign_key_check')).rows).toHaveLength(0);
 }finally{client.close();rmSync(scratch,{recursive:true,force:true});}
});
