import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index';
import {catalogAdministration} from '../src/storage/catalog-admin';
import {scopeFor} from './helpers/connection-scope';
import {storageFixture} from './helpers/storage-fixture';
import {createLifecycleService} from '../src/core/index';
import type {GlobalVersionRef,LifecycleObservation,VersionRef} from '../src/contracts/index';
test('история и выбор переживают перезапуск, очистка полная и откатывается, общий каталог сохраняется',async()=>{
 const f=storageFixture();let storage=await openStorage(f.path);const db=new Database(f.path);let observation:LifecycleObservation={confidence:'confirmed',bot:'present'};
 try{
  let life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});
  const a=scopeFor(storage,'vk:a'),b=scopeFor(storage,'vk:b'),admin=catalogAdministration(storage);const refs:VersionRef[]=[];
  const prompt=await admin.append({kind:'system_prompt',key:'base',text:'global system',createdAt:0,expectedHead:null});if(prompt.status!=='created')throw Error();await admin.selectSystemPrompt(prompt.value.ref as GlobalVersionRef,null);
  const shared=await admin.append({kind:'greeting_template',key:'shared',text:'shared',createdAt:0,expectedHead:null});if(shared.status!=='created')throw Error();
  for(const s of [a,b]){
   const v=await storage.versions.append(s,{kind:'persona',key:'k',text:s.chatId,createdAt:0,expectedHead:null});if(v.status!=='created')throw Error();refs.push(v.value.ref);await storage.versions.select(s,'persona',v.value.ref,null);await storage.versions.select(s,'greeting_template',shared.value.ref,null);
   await storage.messages.append(s,{chatId:s.chatId,messageId:'1',userId:'vk:u',authorName:'',role:'user',text:s.chatId==='vk:a'?'удаляемыйкот':'оставшийсякот',timestamp:0});
  }
  await storage.close();storage=await openStorage(f.path,{versioning:{textMaxLength:1,maxPerEntity:1}});life=createLifecycleService({storage,ownerId:'vk:owner',source:{async observe(){return observation;}}});const fresh=life.current('vk:a');
  expect((await storage.versions.selected(fresh,'persona'))!.ref).toEqual(refs[0]);await storage.versions.select(fresh,'persona',refs[0]!,refs[0]!);
  expect(await storage.versions.append(fresh,{kind:'persona',key:'k',text:'',createdAt:0,expectedHead:null})).toEqual({status:'conflict'});await expect(storage.versions.append(fresh,{kind:'persona',key:'k',text:'',createdAt:0,expectedHead:1})).rejects.toMatchObject({code:'limit_exceeded'});
  observation={confidence:'uncertain',bot:'unknown'};await life.verify('vk:a');
  const operations=[()=>storage.versions.get(fresh,refs[0]!),()=>storage.versions.selected(fresh,'persona'),()=>storage.versions.systemPrompt(fresh),()=>storage.versions.select(fresh,'persona',refs[0]!,refs[0]!),()=>storage.versions.reset(fresh,'persona',refs[0]!),()=>storage.versions.append(fresh,{kind:'persona',key:'k',text:'',createdAt:0,expectedHead:1})];
  for(const op of operations)await expect(op()).rejects.toMatchObject({code:'uncertain_connection'});
  life.decide(life.owner('vk:a','vk:owner'),'continue');expect((await storage.versions.selected(fresh,'persona'))!.text).toBe('vk:a');
  const before=db.prepare('SELECT * FROM chat_content_selections').all();db.exec("CREATE TRIGGER fail_history_cleanup BEFORE DELETE ON local_content_versions BEGIN SELECT RAISE(ABORT,'private'); END");observation={confidence:'confirmed',bot:'absent'};
  await expect(life.verify('vk:a')).rejects.toMatchObject({code:'operation_failed'});expect(db.prepare('SELECT * FROM chat_content_selections').all()).toEqual(before);expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'удаляемыйкот'").all()).toHaveLength(1);db.exec('DROP TRIGGER fail_history_cleanup');
  await life.verify('vk:a');for(const table of ['local_content_versions','chat_content_selections'])expect(db.prepare(`SELECT chat_id FROM ${table} WHERE chat_id='vk:a'`).all()).toEqual([]);
  expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'удаляемыйкот'").all()).toEqual([]);expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'оставшийсякот'").all()).toHaveLength(1);
  observation={confidence:'confirmed',bot:'present'};const next=(await life.verify('vk:a')).scope!;expect(await storage.versions.selected(next,'persona')).toBeNull();expect((await storage.versions.systemPrompt(next))!.text).toBe('global system');
  await expect(storage.versions.get(next,refs[0]!)).rejects.toMatchObject({code:'invalid_input'});for(const op of operations)await expect(op()).rejects.toMatchObject({code:'stale_scope'});
  expect((await storage.versions.selected(life.current('vk:b'),'persona'))!.text).toBe('vk:b');expect(db.pragma('foreign_key_check')).toEqual([]);
  const newer=await storage.versions.append(next,{kind:'persona',key:'k',text:'X',createdAt:0,expectedHead:null});expect(newer.status).toBe('created');life.decide(life.owner('vk:a','vk:owner'),'new');expect(await storage.versions.selected(life.current('vk:a'),'persona')).toBeNull();
 }finally{db.close();await storage.close();f.cleanup();}
});
