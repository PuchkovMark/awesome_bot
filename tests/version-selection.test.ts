import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {catalogAdministration} from '../src/storage/catalog-admin.js';
import type {LocalContentKind,VersionRef} from '../src/contracts/versioning.js';
import {storageFixture} from './helpers/storage-fixture.js';
test('выбор, откат, сброс, конфликт, отсутствующая версия и ошибка записи',async()=>{
 const f=storageFixture(),storage=await openStorage(f.path),db=new Database(f.path),scope=scopeFor(storage,'vk:a');
 try{
  for(const kind of ['persona','greeting_template'] as LocalContentKind[]){
   const one=await storage.versions.append(scope,{kind,key:'k',text:'A',createdAt:0,expectedHead:null});if(one.status!=='created')throw Error();const a=one.value.ref;
   expect(await storage.versions.selected(scope,kind)).toBeNull();await storage.versions.select(scope,kind,a,null);
   const two=await storage.versions.append(scope,{kind,key:'k',text:'B',createdAt:1,expectedHead:1});if(two.status!=='created')throw Error();const b=two.value.ref;
   expect((await storage.versions.selected(scope,kind))!.ref).toEqual(a);
   expect(await storage.versions.select(scope,kind,b,null)).toEqual({status:'conflict'});
   expect(await storage.versions.select(scope,kind,{...a,version:999},a)).toEqual({status:'not_found'});
   db.exec("CREATE TRIGGER fail_select BEFORE UPDATE ON chat_content_selections BEGIN SELECT RAISE(ABORT,'private');END");
   await expect(storage.versions.select(scope,kind,b,a)).rejects.toMatchObject({code:'operation_failed'});expect((await storage.versions.selected(scope,kind))!.ref).toEqual(a);db.exec('DROP TRIGGER fail_select');
   await storage.versions.select(scope,kind,b,a);await storage.versions.select(scope,kind,a,b);expect((await storage.versions.selected(scope,kind))!.text).toBe('A');
   expect(await storage.versions.select(scope,kind,a,a)).toEqual({status:'selected'});
   const g=await catalogAdministration(storage).append({kind,key:'k',text:'G',createdAt:0,expectedHead:null});if(g.status!=='created')throw Error();await storage.versions.select(scope,kind,g.value.ref,a);expect((await storage.versions.selected(scope,kind))!.text).toBe('G');
   await storage.versions.reset(scope,kind,g.value.ref);expect(await storage.versions.selected(scope,kind)).toBeNull();
  }
  await expect(storage.versions.select(scope,'system_prompt' as LocalContentKind,{area:'global',kind:'system_prompt',key:'k',version:1},null)).rejects.toMatchObject({code:'invalid_input'});
  const wrong:VersionRef={area:'local',chatId:'vk:other',generation:scope.generation,kind:'persona',key:'k',version:1};await expect(storage.versions.select(scope,'persona',wrong,null)).rejects.toMatchObject({code:'invalid_input'});
 }finally{db.close();await storage.close();f.cleanup();}
});
