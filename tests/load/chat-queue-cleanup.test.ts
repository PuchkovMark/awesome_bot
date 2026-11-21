import Database from 'better-sqlite3';
import { expect,test } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStorage } from '../../src/storage/index.js';
import { lifecycleBackend } from '../../src/storage/lifecycle-store.js';
import { queueBackend } from '../../src/storage/queue-registry.js';
import { scopeFor } from '../helpers/connection-scope.js';
import { storageFixture } from '../helpers/storage-fixture.js';
import { resolve } from 'node:path';
import { seedLargeQueueChat, recordQueueLoad } from '../helpers/queue-load-fixture.js';
test('300000 сообщений с FTS, профилями и заданиями очищаются с запасом владения',async()=>{
 const f=storageFixture(), storage=await openStorage(f.path), db=new Database(f.path);db.pragma('foreign_keys=ON');
 let child:ReturnType<typeof spawn>|undefined;
 try{
 const scope=scopeFor(storage,'vk:large'),other=scopeFor(storage,'vk:other');
 await storage.chats.create(scope,{responseMode: 'normal',enabled:true,createdAt:0});
 await storage.messages.append(other,{chatId:'vk:other',messageId:'keep',userId:'vk:u',authorName:'',role:'user',text:'сохранённыйкот',timestamp:0});
 seedLargeQueueChat(db,scope.generation,300000);
 const backend=queueBackend(storage);backend.acquire('owner',30000,10000);
 // Другой процесс ждёт SQLite и проверяет действующего владельца на собственном соединении.
 child=spawn(process.execPath,['--input-type=module','--eval',`
  const {openStorage}=await import(process.argv[2]+'/storage/index.js');
  const {queueBackend}=await import(process.argv[2]+'/storage/queue-registry.js');
  const storage=await openStorage(process.argv[1]);
  process.stdout.write('ready\\n');setTimeout(async()=>{try {
   try{queueBackend(storage).acquire('contender',30000,10000);throw Error('unexpected_owner');}
   catch(error){if(error.code!=='queue_owned')throw error;}
   process.stdout.write('checked\\n');
  }catch{process.exitCode=1;}finally{await storage.close();}},20);
 `,f.path,resolve('dist')],{stdio:['ignore','pipe','pipe']});
 let output='',errors='';child.stdout!.on('data',chunk=>{output+=String(chunk);});child.stderr!.on('data',chunk=>{errors+=String(chunk);});
 await new Promise<void>(resolve=>child!.stdout!.once('data',()=>resolve()));
 backend.renew('owner',30000);const started=performance.now();
 const life=lifecycleBackend(storage);life.apply(life.begin('vk:large'),{confidence:'confirmed',bot:'absent'});
 const cleanupMs=performance.now()-started;expect(cleanupMs+10000).toBeLessThan(30000);backend.check('owner');
 const [exit]=await once(child,'exit');expect(exit,errors).toBe(0);expect(output).toContain('checked');
 for(const table of ['notice_periods','queue_jobs','queue_turns','messages','chat_participants','participant_profiles','profile_facts','local_content_versions','chat_content_selections','bot_admin_grants','bot_admin_revocations','bot_admin_revocation_audit','bot_admin_controls','chats','chat_connections'])expect(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE chat_id='vk:large'`).get()).toEqual({n:0});
 expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'удаляемыйкот'").all()).toEqual([]);
 expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'служебныйслед'").all()).toEqual([]);
 expect(await storage.messages.list(other,{limit:1})).toHaveLength(1);expect(db.pragma('foreign_key_check')).toEqual([]);
 backend.release('owner');await recordQueueLoad({fixtureMessages:300000,fixtureNotices:1000,fixtureJobs:300000,fixtureProfiles:2000,cleanupMs,leaseMs:30000,marginMs:10000});
 }finally{child?.kill();db.close();await storage.close();f.cleanup();}
});
