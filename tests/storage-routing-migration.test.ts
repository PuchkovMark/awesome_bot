import { participantFixture } from './helpers/participant-fixture';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';

test('версия 7 сохраняет данные, FK и checksums; оба режима становятся normal', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    migrate(db, migrations.slice(0, 7));
    db.exec(`INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES ('vk:a','always','UTC',0,0),('vk:b','mention','UTC',1,0);
   INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:a',1,0,'active');
   INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:a','1','vk:u','','user','проверка',0);
   INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) VALUES('vk:a',1,1,0,100,'queued');`);
    const pf = participantFixture(db);
    pf.participant('vk:a', 'vk:u');
    pf.profile('vk:a', 'vk:u');
    pf.fact('vk:a', 'vk:u');
    db.exec(`INSERT INTO bot_admin_grants VALUES('vk:a','vk:u','creator',0,NULL); INSERT INTO bot_admin_revocations VALUES('vk:a','vk:r','vk:owner',0);INSERT INTO bot_admin_revocation_audit VALUES('vk:a','vk:r',1,0,0,'private');
   INSERT INTO global_content_versions VALUES('system_prompt','s',1,'system',0),('persona','p',1,'persona',0);INSERT INTO global_prompt_selection VALUES('system_prompt','s',1);
   INSERT INTO local_content_versions VALUES('vk:a',1,'persona','local',1,'local',0);INSERT INTO chat_content_selections VALUES('vk:a',1,'persona',NULL,NULL,'local',1);
   INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:a','2','vk:u','','user','running',0),('vk:a','3','vk:u','','user','terminal',0);
   INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,owner) VALUES('vk:a',1,2,0,100,'running','owner');
   INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state,outcome) VALUES('vk:a',1,3,0,100,'terminal','completed');`);
    const savedTables = [
      'chat_connections',
      'lifecycle_clock',
      'chat_participants',
      'participant_profiles',
      'profile_facts',
      'bot_admin_grants',
      'bot_admin_revocations',
      'bot_admin_revocation_audit',
      'global_content_versions',
      'global_prompt_selection',
      'local_content_versions',
      'chat_content_selections',
    ];
    const saved = savedTables.map((t) =>
      db
        .prepare(
          t === 'chat_connections'
            ? 'SELECT *,NULL AS pause_reason,0 AS erased_author_number FROM chat_connections'
            : 'SELECT * FROM ' + t,
        )
        .all(),
    );
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    const jobs = db.prepare('SELECT * FROM queue_jobs').all();
    migrate(db);
    savedTables.forEach((t, i) => expect(db.prepare('SELECT * FROM ' + t).all()).toEqual(saved[i]));
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=7').all()).toEqual(history);
    expect(db.prepare('SELECT response_mode,enabled FROM chats ORDER BY chat_id').all()).toEqual([
      { response_mode: 'normal', enabled: 0 },
      { response_mode: 'normal', enabled: 1 },
    ]);
    expect(db.prepare('SELECT * FROM queue_jobs').all()).toMatchObject(jobs);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.exec(
      "UPDATE messages SET purpose='service_notice'; INSERT INTO messages_fts(messages_fts) VALUES('rebuild')",
    );
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'проверка'").all(),
    ).toEqual([]);
    db.exec("UPDATE messages SET purpose='conversation'");
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'проверка'").all(),
    ).toHaveLength(1);
    migrate(db);
  } finally {
    db.close();
  }
});
