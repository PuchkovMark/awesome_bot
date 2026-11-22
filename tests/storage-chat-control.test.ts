import Database from 'better-sqlite3';
import { expect,test } from 'vitest';
import { createAuthorizationService,createLifecycleService } from '../src/core/index.js';
import { openStorage } from '../src/storage/index.js';
import { chatControlStore } from '../src/storage/chat-control-store.js';
import { migrate } from '../src/storage/migrate.js';
import { migrations } from '../src/storage/migrations/index.js';
import { storageFixture } from './helpers/storage-fixture.js';

const chat='vk:2000000010', neighbor='vk:2000000011', ownerId='vk:1';

test('миграция сохраняет старую очередь, а выключение аннулирует её и не теряет паузу',async()=>{
  const files=storageFixture(), original=new Database(files.path);
  try {
    migrate(original,migrations.slice(0,15));
    original.exec(`UPDATE lifecycle_clock SET value=2;
      INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('${chat}',1,0,'active'),('${neighbor}',2,0,'active');
      INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode) VALUES ('${chat}','UTC',1,1,'active'),('${neighbor}','UTC',1,1,'normal');
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES ('${chat}','1','vk:5','','user','Синтетическая реплика',1);
      INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,route_kind,route_mode,route_group)
        VALUES ('${chat}',1,1,1,3000000,'queued','mention','active',1);`);
  } finally {original.close();}
  let storage=await openStorage(files.path);
  const lifecycle=()=>createLifecycleService({storage,ownerId,source:{async observe(){return {confidence:'unavailable',bot:'unknown'};}}});
  const diagnostic=new Database(files.path);
  try {
    const current=lifecycle().current(chat);
    const store=chatControlStore(storage);
    expect(store.read(current)).toMatchObject({enabled:true,mode:'active',autonomousDisabled:false,responseRevision:0});
    expect((await storage.messages.list(current,{limit:5}))[0]?.text).toBe('Синтетическая реплика');
    const waiting=diagnostic.prepare('SELECT state,outcome,control_revision AS rev FROM queue_jobs');
    expect(waiting.get()).toEqual({state:'queued',outcome:null,rev:0});
    const auth=await createAuthorizationService({config:{ownerId,reasonMaxLength:500,reasonRetentionDays:90},
      store:storage.authorization,now:()=>100});
    try {
      const context=auth.context({scope:current,userId:ownerId,kind:'owner'});
      await auth.controlChat(context,{kind:'pause'},()=>true,10);
      const received=store.capture(current);
      await auth.controlChat(context,{kind:'off'},()=>true,11);
      const whileOff=store.capture(current);
      await auth.controlChat(context,{kind:'on'},()=>true,12);
      expect(received().ordinary).toBe(false);
      expect(whileOff()).toEqual({journal:false,ordinary:false});
      expect(store.capture(current)()).toEqual({journal:true,ordinary:true});
      expect(waiting.get()).toEqual({state:'terminal',outcome:'interrupted',rev:0});
    } finally {auth.dispose();}
    await storage.close();
    storage=await openStorage(files.path);
    const life=lifecycle();
    expect(chatControlStore(storage).read(life.current(chat))).toMatchObject({
      enabled:true,mode:'active',pausedUntil:900100,nextParticipantPause:1800100,responseRevision:1,
    });
    const replacement=life.decide(life.owner(chat,ownerId),'new');
    expect(chatControlStore(storage).read(replacement)).toMatchObject({pausedUntil:null,responseRevision:0,mode:'normal'});
    expect(chatControlStore(storage).read(life.current(neighbor))).toMatchObject({enabled:true,mode:'normal'});
    expect(diagnostic.prepare('SELECT count(*) AS n FROM chat_control_commands').get()).toEqual({n:0});
  } finally {diagnostic.close();await storage.close();files.cleanup();}
});
