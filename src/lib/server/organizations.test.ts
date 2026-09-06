import {expect,it,vi} from 'vitest';
import {createClient} from '@libsql/client';
import {drizzle} from 'drizzle-orm/libsql';
import {migrate} from 'drizzle-orm/libsql/migrator';
import {fileURLToPath} from 'node:url';
import * as schema from './db/schema';
const state=vi.hoisted(()=>({db:undefined as unknown}));
vi.mock('./db',()=>({get db(){return state.db;}}));
import {listInstitutions,getInstitutionBySlug} from './queries';
it('counts each active source once while retaining all organizational roles',async()=>{
 const client=createClient({url:'file::memory:'});
 try{
  const db=drizzle(client,{schema});state.db=db;
  await migrate(db,{migrationsFolder:fileURLToPath(new URL('../../../drizzle',import.meta.url))});
  await db.insert(schema.institutions).values({id:'org',slug:'org',name:'Organization'});
  await db.insert(schema.sources).values([{id:'book',slug:'book',title:'Book',type:'book'},{id:'hidden',slug:'hidden',title:'Hidden',type:'book',status:'hidden'}]);
  await db.insert(schema.sourceInstitutions).values([
   {id:'author',sourceId:'book',institutionId:'org',role:'author'},
   {id:'publisher',sourceId:'book',institutionId:'org',role:'publisher'},
   {id:'hidden',sourceId:'hidden',institutionId:'org',role:'author'}
  ]);
  expect((await listInstitutions())[0].sourceCount).toBe(1);
  const detail=await getInstitutionBySlug('org');expect(detail?.sources).toHaveLength(1);
  expect(detail?.sources[0].roles.sort()).toEqual(['author','publisher']);
 }finally{client.close();}
});
