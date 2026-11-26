import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { advanceClock } from '../src/storage/lifecycle-clock';
import { restrictPreviousSources } from '../src/storage/connection-recovery';

test('граница группы скрывает старые источники и старую выдачу прав, сохраняя исходные записи', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state,pause_reason,established) VALUES ('vk:99',1,3,'uncertain','startup',1);
      INSERT INTO chats(chat_id,response_mode,enabled,timezone,created_at) VALUES ('vk:99','normal',1,'UTC',0);
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES ('vk:99','10','vk:1','','user','до',100),('vk:98','5','vk:1','','user','сосед',100);
      INSERT INTO bot_admin_grants VALUES ('vk:99','vk:1','explicit',10,NULL)`);
    restrictPreviousSources(db, {
      chatId: 'vk:99',
      generation: 1,
      revision: 3,
      controlRevision: 0,
    });
    expect(db.prepare('SELECT text FROM personal_visible_messages').pluck().all()).toEqual([
      'сосед',
    ]);
    expect(db.prepare('SELECT count(*) FROM messages').pluck().get()).toBe(2);
    expect(db.prepare('SELECT user_id FROM bot_admin_grants').pluck().all()).toEqual([]);
    expect(db.prepare('SELECT user_id FROM unverified_admin_grants').pluck().all()).toEqual([
      'vk:1',
    ]);
  } finally {
    db.close();
  }
});

test('миграция восстановления различает начатые диалоги и первый допуск', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations.slice(0, 58));
    db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state,pause_reason) VALUES
      ('vk:1',1,0,'active',NULL), ('vk:2',2,1,'uncertain','startup'),
      ('vk:3',3,1,'uncertain','observation_lost'), ('vk:4',4,0,'uncertain','first_seen'),
      ('vk:5',5,0,'uncertain',NULL);
      INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
        VALUES ('vk:2','10','vk:2','','user','привет',0);
      INSERT INTO admin_observations(chat_id,generation,opened_at) VALUES ('vk:3',3,100);
      INSERT INTO chats(chat_id,response_mode,enabled,timezone,created_at) VALUES
        ('vk:2','normal',0,'UTC',0),('vk:4','normal',1,'UTC',0),('vk:5','normal',1,'UTC',0)`);
    migrate(db);
    migrate(db);
    expect(
      db.prepare('SELECT established FROM chat_connections ORDER BY generation').pluck().all(),
    ).toEqual([1, 1, 1, 0, 0]);
    expect(db.prepare("SELECT enabled FROM chats WHERE chat_id='vk:2'").pluck().get()).toBe(0);
  } finally {
    db.close();
  }
});

test('счётчик независим от чатов по схеме; миграция сохраняет версию 4 с журналом без настроек', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    migrate(db, migrations.slice(0, 4));
    db.exec(
      "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:2','','user','кот',0)",
    );
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=4').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM chat_connections').get()).toMatchObject({
      chat_id: 'vk:1',
      state: 'uncertain',
    });
    expect(
      db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'кот'").all(),
    ).toHaveLength(1);
    expect(
      (db.pragma('table_info(lifecycle_clock)') as { name: string }[]).map((r) => r.name),
    ).toEqual(['singleton', 'value']);
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
      name: string;
    }[];
    for (const { name } of tables) {
      const fks = db.pragma(`foreign_key_list('${name}')`) as { table: string }[];
      expect(fks.some((f) => f.table === 'lifecycle_clock')).toBe(false);
      if (name === 'lifecycle_clock') expect(fks).toEqual([]);
    }
    expect(
      db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type='trigger' AND sql LIKE '%lifecycle_clock%'",
        )
        .all(),
    ).toEqual([]);
    expect(db.transaction(() => advanceClock(db))()).toBe(2);
    db.exec('UPDATE lifecycle_clock SET value=9007199254740991');
    expect(() => db.transaction(() => advanceClock(db))()).toThrow('operation_failed');
  } finally {
    db.close();
  }
});

test('миграция 21 сохраняет существующую паузу с неизвестной причиной', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 20));
    db.exec(`
      INSERT INTO chat_connections(chat_id,generation,revision,state)
      VALUES ('vk:1',1,7,'uncertain'),('vk:2',2,4,'active');
    `);
    const before = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    migrate(db);
    expect(
      db.prepare('SELECT * FROM schema_migrations WHERE version<=20 ORDER BY version').all(),
    ).toEqual(before);
    expect(
      db
        .prepare(
          'SELECT chat_id,generation,revision,state,pause_reason FROM chat_connections ORDER BY chat_id',
        )
        .all(),
    ).toEqual([
      { chat_id: 'vk:1', generation: 1, revision: 7, state: 'uncertain', pause_reason: null },
      { chat_id: 'vk:2', generation: 2, revision: 4, state: 'active', pause_reason: null },
    ]);
    const updateCause = db.prepare('UPDATE chat_connections SET pause_reason=? WHERE chat_id=?');
    expect(() => updateCause.run('unsupported', 'vk:1')).toThrow('CHECK');
    expect(() => updateCause.run('startup', 'vk:2')).toThrow('CHECK');
    expect(updateCause.run('startup', 'vk:1').changes).toBe(1);
  } finally {
    db.close();
  }
});

function clockIsIndependent(db: Database.Database): boolean {
  const columns = (db.pragma('table_info(lifecycle_clock)') as { name: string }[]).map(
    (r) => r.name,
  );
  if (columns.join(',') !== 'singleton,value') return false;
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {
    name: string;
  }[];
  for (const { name } of tables) {
    const fks = db.pragma(`foreign_key_list('${name}')`) as { table: string }[];
    if (
      fks.some((f) => f.table === 'lifecycle_clock') ||
      (name === 'lifecycle_clock' && fks.length)
    )
      return false;
  }
  return (
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='trigger' AND sql LIKE '%lifecycle_clock%'",
      )
      .all().length === 0
  );
}
test('проверка независимости счётчика обнаруживает связь с чатом и лишнее поле', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    expect(clockIsIndependent(db)).toBe(true);
    db.exec(
      'CREATE TABLE bad_link(chat_id TEXT, clock_id INTEGER REFERENCES lifecycle_clock(singleton))',
    );
    expect(clockIsIndependent(db)).toBe(false);
    db.exec('DROP TABLE bad_link; ALTER TABLE lifecycle_clock ADD COLUMN chat_id TEXT');
    expect(clockIsIndependent(db)).toBe(false);
  } finally {
    db.close();
  }
});
