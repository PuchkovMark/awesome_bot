import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { chatControlStore } from '../src/storage/chat-control-store.js';
import { openStorage } from '../src/storage/index.js';
import { lifecycleBackend } from '../src/storage/lifecycle-store.js';
import { migrate } from '../src/storage/migrate.js';
import { migrations } from '../src/storage/migrations/index.js';
import { storageFixture } from './helpers/storage-fixture.js';

test('версия 17 сохраняет настройки, очередь, историю и период уведомлений без старых начислений', async () => {
  const files = storageFixture();
  const db = new Database(files.path);
  let storage: Awaited<ReturnType<typeof openStorage>> | undefined;
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 16));
    const previous = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    db.exec(`UPDATE lifecycle_clock SET value=2;
      INSERT INTO chat_connections(chat_id,generation,revision,state)
        VALUES ('vk:10',1,0,'active'),('vk:11',2,0,'active');
      INSERT INTO chats(chat_id,timezone,enabled,created_at,response_mode) VALUES ('vk:10','UTC',1,1,'active');
      INSERT INTO chat_controls(chat_id,generation,paused_until,next_participant_pause) VALUES ('vk:10',1,50,100);
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES ('vk:10','1','vk:10','','user','Синтетическое обращение',1);
      INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,route_kind,route_mode,route_group)
        VALUES ('vk:10',1,1,1,100,'queued','direct_message','normal',0);
      INSERT INTO notice_periods(chat_id,generation,next_at) VALUES ('vk:10',1,110);`);
    storage = await openStorage(files.path);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=16 ORDER BY version').all()).toEqual(previous);
    const lifecycle = lifecycleBackend(storage);
    const scope = lifecycle.current('vk:10');
    expect(await storage.queue.get(scope, 1)).toMatchObject({ state: 'queued', messageId: 1 });
    expect(await storage.messages.get(scope, 1)).toMatchObject({ text: 'Синтетическое обращение' });
    expect(chatControlStore(storage).read(scope)).toMatchObject({ enabled: true, mode: 'active', pausedUntil: 50 });
    expect(db.prepare('SELECT next_at FROM notice_periods').get()).toEqual({ next_at: 110 });
    expect(db.prepare('SELECT * FROM request_quota_admissions').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM autonomous_quota_reservations').all()).toEqual([]);
    db.exec(`INSERT INTO request_quota_admissions VALUES (1,'vk:10',1,'vk:10',5),(2,'vk:11',2,'vk:11',6);
      INSERT INTO autonomous_quota_reservations(chat_id,generation,reserved_at,owner)
        VALUES ('vk:10',1,5,'test'),('vk:11',2,6,'test');`);
    lifecycle.ownerDecision(lifecycle.begin('vk:10'), 'new');
    expect(db.prepare('SELECT chat_id FROM request_quota_admissions').all()).toEqual([{ chat_id: 'vk:11' }]);
    expect(db.prepare('SELECT chat_id FROM autonomous_quota_reservations').all()).toEqual([{ chat_id: 'vk:11' }]);
  } finally {
    await storage?.close();
    db.close();
    files.cleanup();
  }
});
