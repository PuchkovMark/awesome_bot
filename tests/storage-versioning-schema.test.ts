import { participantFixture } from './helpers/participant-fixture';
import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { openStorage } from '../src/storage/index';
import { scopeFor } from './helpers/connection-scope';
import { createLifecycleService } from '../src/core/index';
import { storageFixture } from './helpers/storage-fixture';
test('миграция 6 сохраняет данные версии 5 и проверяет все ссылки', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    migrate(db, migrations.slice(0, 5));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:1',1,0,'active'),('vk:2',2,0,'active')",
    );
    const pf = participantFixture(db);
    pf.chat('vk:1');
    pf.participant('vk:1', 'vk:u');
    pf.profile('vk:1', 'vk:u');
    pf.fact('vk:1', 'vk:u');
    db.exec(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:u','','user','сохранённыйкот',0); INSERT INTO bot_admin_grants VALUES ('vk:1','vk:u','creator',0,NULL); INSERT INTO bot_admin_revocations VALUES ('vk:1','vk:r','vk:owner',1); INSERT INTO bot_admin_revocation_audit VALUES ('vk:1','vk:r',1,0,0,'private'); INSERT INTO bot_admin_controls VALUES ('vk:1',1)",
    );
    const oldTables = [
      'messages',
      'chats',
      'chat_participants',
      'participant_profiles',
      'profile_facts',
      'bot_admin_grants',
      'bot_admin_revocations',
      'bot_admin_revocation_audit',
      'bot_admin_controls',
      'lifecycle_clock',
    ];
    const saved = oldTables.map((t) => db.prepare('SELECT * FROM ' + t).all());
    const before = db.prepare('SELECT * FROM schema_migrations').all(),
      connections = db.prepare('SELECT * FROM chat_connections').all();
    migrate(db, migrations.slice(0, 7));
    migrate(db, migrations.slice(0, 7));
    oldTables.forEach((t, i) => expect(db.prepare('SELECT * FROM ' + t).all()).toEqual(saved[i]));
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'сохранённыйкот'").all(),
    ).toHaveLength(1);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=5').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM chat_connections').all()).toEqual(connections);
    db.exec(
      "INSERT INTO global_content_versions VALUES ('system_prompt','base',1,'literal',0),('persona','p',1,'global',0)",
    );
    expect(() =>
      db.exec("INSERT INTO local_content_versions VALUES ('vk:1',1,'system_prompt','p',1,'bad',0)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO local_content_versions VALUES ('vk:1',2,'persona','p',1,'bad',0)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO local_content_versions VALUES ('vk:1',1,'persona','p',0,'bad',0)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO local_content_versions VALUES ('vk:1',1,'persona','p',1,'bad',-1)"),
    ).toThrow();
    db.exec("INSERT INTO local_content_versions VALUES ('vk:1',1,'persona','p',1,'own',0)");
    for (const sql of [
      "INSERT INTO chat_content_selections VALUES ('vk:2',2,'persona',NULL,NULL,'p',1)",
      "INSERT INTO chat_content_selections VALUES ('vk:1',1,'persona','p',1,'p',1)",
      "INSERT INTO chat_content_selections VALUES ('vk:1',1,'persona',NULL,NULL,NULL,NULL)",
      "INSERT INTO global_prompt_selection VALUES ('persona','p',1)",
      "INSERT INTO global_prompt_selection VALUES ('system_prompt','missing',1)",
    ])
      expect(() => db.exec(sql)).toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
test('новые локальные данные очищаются атомарно, общие и другой чат сохраняются', async () => {
  const f = storageFixture(),
    storage = await openStorage(f.path),
    db = new Database(f.path);
  db.pragma('foreign_keys=ON');
  const life = createLifecycleService({
    storage,
    ownerId: 'vk:owner',
    source: {
      async observe() {
        return { confidence: 'confirmed', bot: 'absent' };
      },
    },
  });
  try {
    const a = scopeFor(storage, 'vk:1'),
      b = scopeFor(storage, 'vk:2');
    db.exec(
      "INSERT INTO global_content_versions VALUES ('system_prompt','base',1,'literal',0); INSERT INTO global_prompt_selection VALUES ('system_prompt','base',1)",
    );
    for (const s of [a, b]) {
      db.prepare("INSERT INTO local_content_versions VALUES (?,?,'persona','p',1,'local',0)").run(
        s.chatId,
        s.generation,
      );
      db.prepare("INSERT INTO chat_content_selections VALUES (?,?,'persona',NULL,NULL,'p',1)").run(
        s.chatId,
        s.generation,
      );
    }
    db.exec(
      "CREATE TRIGGER fail_version_cleanup BEFORE DELETE ON local_content_versions BEGIN SELECT RAISE(ABORT,'private');END",
    );
    await expect(life.verify('vk:1')).rejects.toMatchObject({ code: 'operation_failed' });
    expect(db.prepare('SELECT * FROM chat_content_selections').all()).toHaveLength(2);
    db.exec('DROP TRIGGER fail_version_cleanup');
    await life.verify('vk:1');
    expect(db.prepare('SELECT chat_id FROM local_content_versions').all()).toEqual([
      { chat_id: 'vk:2' },
    ]);
    expect(db.prepare('SELECT chat_id FROM chat_content_selections').all()).toEqual([
      { chat_id: 'vk:2' },
    ]);
    expect(db.prepare('SELECT * FROM global_prompt_selection').all()).toHaveLength(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
    await storage.close();
    f.cleanup();
  }
});
