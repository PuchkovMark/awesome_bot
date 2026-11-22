import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { queueConfig } from '../src/core/chat-queue/validation.js';
import { historyClearStore } from '../src/storage/history-retention-store.js';
import { openStorage } from '../src/storage/index.js';
import { lifecycleBackend } from '../src/storage/lifecycle-store.js';
import { queueBackend } from '../src/storage/queue-registry.js';
import { scopeFor } from './helpers/connection-scope.js';
import { storageFixture } from './helpers/storage-fixture.js';

const day = 86_400_000;
const epoch = 1_800_000_000_000;
const chat = 'vk:2000000001' as const;
const owner = {initiator:'vk:1',origin:'vk:1',owner:true} as const;
const input = (messageId: string, timestamp: number) => ({
  chatId:chat, userId:'vk:2' as const, messageId, timestamp, text:'Синтетическая цитата', authorName:'', role:'user' as const,
});

test('единая точная граница чтения, FTS, цитаты и входа; прежний срок сохраняется после увеличения', async () => {
  const files = storageFixture();
  const db = new Database(files.path);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(epoch);
  const storage = await openStorage(files.path, { messageRetentionDays: 30 });
  const second = await openStorage(files.path, { messageRetentionDays: 90 });
  try {
    const scope = scopeFor(storage, chat);
    const queue = queueBackend(storage), other = queueBackend(second);
    queue.acquire('one', 30_000, 10_000);
    const old = await storage.messages.append(scope, input('old', epoch - 30 * day + 1));
    expect(await storage.messages.get(scope, old.id)).not.toBeNull();
    expect(await storage.contextMessages.search(scope, 'Цитата', 10, 256)).toHaveLength(1);
    clock.mockReturnValue(epoch + 1);
    expect(await storage.messages.get(scope, old.id)).toBeNull();
    expect(await storage.messages.list(scope, {limit:20})).toEqual([]);
    expect(await storage.contextMessages.list(scope,{limit:20})).toEqual([]);
    expect(await storage.contextMessages.page(scope,{cutoffId:old.id,limit:10,textLimit:256})).toEqual([]);
    expect(await storage.contextMessages.reply(scope,'old',old.id,256)).toBeNull();
    expect(await storage.contextMessages.search(scope,'Цитата',10,256)).toEqual([]);
    expect(db.prepare('SELECT id FROM messages').all()).toEqual([{id:old.id}]);

    expect(() => other.acquire('two',30_000,10_000)).toThrow('queue_owned');
    expect(db.prepare('SELECT retention_ms FROM history_retention_policy').get()).toEqual({retention_ms:30*day});
    queue.release('one');
    clock.mockReturnValue(epoch+day);
    other.acquire('two',30_000,10_000);
    const continued=lifecycleBackend(second).current(chat);
    expect(continued.generation).toBe(scope.generation);
    expect(await second.messages.get(continued,old.id)).toBeNull();
    const routed=vi.fn(()=>true);
    expect(other.admit('two',continued,input('old',epoch-30*day+1),routed,queueConfig())).toEqual({status:'history_unavailable'});
    expect(routed).not.toHaveBeenCalled();
    other.pruneHistory('two');
    expect(db.prepare('SELECT id FROM messages').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM history_deleted_inputs').all()).toEqual([]);
    expect(other.admit('two',continued,input('fresh',epoch+day),routed,queueConfig()).status).toBe('queued');
    other.release('two');
  } finally {
    clock.mockRestore();
    await second.close(); await storage.close(); db.close(); files.cleanup();
  }
});

test('обслуживание ограничено 100 сообщениями, откатывает ключи и физическое удаление при сбое и работает в uncertain', async () => {
  const files=storageFixture(), db=new Database(files.path);
  const storage=await openStorage(files.path,{messageRetentionDays:30});
  db.pragma('foreign_keys=ON');
  try {
    const scope=scopeFor(storage,chat), queue=queueBackend(storage);
    const time=Date.now();
    queue.acquire('lease',30_000,10_000);
    await storage.chats.create(scope,{enabled:true,responseMode:'normal',createdAt:time});
    const append=await storage.messages.append(scope,input('first',time-day));
    db.exec(`WITH RECURSIVE seq(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM seq WHERE n<=100)
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      SELECT '${chat}',n,'vk:2','','user','Индексируемая история',${time} FROM seq;
      INSERT INTO chat_participants(chat_id,user_id,role,status) VALUES('${chat}','vk:2','member','present');
      INSERT INTO participant_profiles(chat_id,user_id,created_at,updated_at) VALUES('${chat}','vk:2',1,1);
      INSERT INTO profile_facts(chat_id,user_id,field_key,value,source_kind,source_message_id,reliability,visibility,created_at,updated_at)
      VALUES ('${chat}','vk:2','inferred','a','inferred','first','unknown','bot',1,1),
      ('${chat}','vk:2','unknown','b','inferred',NULL,'unknown','bot',1,1),
      ('${chat}','vk:2','self','c','self','first','confirmed','bot',1,1),
      ('${chat}','vk:2','admin','d','admin',NULL,'confirmed','bot',1,1);
      INSERT INTO request_quota_admissions VALUES (1,'${chat}',${scope.generation},'vk:2',${time});
      CREATE TRIGGER break_delete BEFORE DELETE ON messages WHEN OLD.platform_message_id='2'
      BEGIN SELECT RAISE(ABORT,'test failure'); END;`);
    const store=historyClearStore(storage);
    const pending=store.request(scope,owner,'prepare',time,false)!;
    expect(pending.count).toBe(101);
    expect(store.confirm(scope,owner,pending.code,time)).toEqual({count:101});
    expect(await storage.messages.get(scope,append.id)).toBeNull();
    db.prepare("UPDATE chat_connections SET state='uncertain' WHERE chat_id=?").run(chat);
    expect(() => queue.pruneHistory('lease')).toThrow('operation_failed');
    expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({count:101});
    expect(db.prepare('SELECT * FROM history_deleted_inputs').all()).toEqual([]);
    db.exec('DROP TRIGGER break_delete');
    expect(queue.pruneHistory('lease')).toBe(true);
    expect(db.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({count:1});
    queue.release('lease');
    queue.acquire('replacement',30_000,10_000);
    expect(queue.pruneHistory('replacement')).toBe(false);
    expect(db.prepare('SELECT count(*) AS count FROM history_deleted_inputs').get()).toEqual({count:101});
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'История'").all()).toEqual([]);
    expect(db.prepare('SELECT field_key FROM profile_facts ORDER BY id').all()).toEqual([{field_key:'self'},{field_key:'admin'}]);
    expect(db.prepare('SELECT job_id FROM request_quota_admissions').all()).toEqual([{job_id:1}]);
    expect(db.prepare('SELECT state FROM chat_connections').get()).toEqual({state:'uncertain'});
    queue.release('replacement');
    const life=lifecycleBackend(storage);
    const replacement=life.ownerDecision(life.begin(chat),'new');
    expect(replacement.generation).not.toBe(scope.generation);
    for(const table of ['history_deleted_inputs','history_clear_requests','history_retention_boundaries']) {
      expect(db.prepare('SELECT * FROM '+table).all()).toEqual([]);
    }
  } finally {
    db.close(); await storage.close();files.cleanup();
  }
});

test('отдельный срок очищает закрытую трассировку при доступном исходном сообщении',async()=>{
  const files=storageFixture(), db=new Database(files.path);
  const clock=vi.spyOn(Date,'now').mockReturnValue(epoch);
  const storage=await openStorage(files.path,{messageRetentionDays:30});
  try {
    const scope=scopeFor(storage,chat), queue=queueBackend(storage);
    queue.acquire('one',30_000,10_000);
    const admitted=queue.admit('one',scope,input('source',epoch),()=>true,queueConfig());
    expect(admitted.status).toBe('queued');
    const work=queue.take('one')!;
    expect(queue.finish('one',work,'completed')).toBe('completed');
    queue.release('one');
    clock.mockReturnValue(epoch+7*day);
    queue.acquire('two',30_000,10_000);
    expect(await storage.traces.get(scope,work.id)).toBeNull();
    expect(db.prepare('SELECT job_id FROM response_traces').get()).toEqual({job_id:work.id});
    queue.pruneHistory('two');
    expect(db.prepare('SELECT job_id FROM response_traces').get()).toBeUndefined();
    expect(await storage.messages.get(scope,work.messageId)).toMatchObject({messageId:'source'});
    expect(await storage.queue.get(scope,work.id)).toMatchObject({outcome:'completed'});
    queue.release('two');
  } finally {clock.mockRestore();await storage.close();db.close();files.cleanup();}
});
