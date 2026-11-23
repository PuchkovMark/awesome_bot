import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';

test('миграция с версии 17 сохраняет журнал, индекс поиска, настройки, очередь и начисления', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 17));
    const history = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:1',1,0,'active');
      INSERT INTO chats(chat_id,created_at,timezone,response_mode,enabled) VALUES('vk:1',1,'UTC','active',0);
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES('vk:1','4','vk:1','','user','Синтетическая цитата',1);
      INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) VALUES('vk:1',1,1,1,100,'queued');
      INSERT INTO request_quota_admissions VALUES(1,'vk:1',1,'vk:1',5);`);
    migrate(db);
    expect(
      db.prepare('SELECT * FROM schema_migrations WHERE version<=17 ORDER BY version').all(),
    ).toEqual(history);
    expect(db.prepare('SELECT name FROM schema_migrations WHERE version=18').get()).toEqual({
      name: 'chat-history-retention',
    });
    expect(db.prepare('SELECT enabled,response_mode FROM chats').get()).toEqual({
      enabled: 0,
      response_mode: 'active',
    });
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'цитата'").get(),
    ).toEqual({ rowid: 1 });
    expect(db.prepare('SELECT state FROM queue_jobs').get()).toEqual({ state: 'queued' });
    expect(db.prepare('SELECT job_id FROM request_quota_admissions').get()).toEqual({ job_id: 1 });
    expect(db.prepare('SELECT * FROM history_retention_policy').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
