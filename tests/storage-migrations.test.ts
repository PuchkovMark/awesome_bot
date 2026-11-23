import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { openConnection } from '../src/storage/connection';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
import { storageFixture } from './helpers/storage-fixture';

const insert =
  "INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:2','Имя','user','старый',0)";
test('миграция 13 сохраняет поколения и связывает отметки с конкретным чатом и поколением', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db, migrations.slice(0, 12));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:1',1,0,'active'),('vk:2',2,0,'uncertain')",
    );
    const history = db.prepare('SELECT * FROM schema_migrations').all();
    const connections = db.prepare('SELECT * FROM chat_connections').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=12').all()).toEqual(history);
    expect(db.prepare('SELECT * FROM chat_connections').all()).toEqual(connections);
    const add = db.prepare('INSERT INTO connection_membership_signals VALUES (?,?,?)');
    add.run('vk:1', 1, '8');
    add.run('vk:2', 2, '8');
    expect(() => add.run('vk:1', 2, '9')).toThrow();
    db.prepare('DELETE FROM chat_connections WHERE chat_id=?').run('vk:1');
    expect(db.prepare('SELECT * FROM connection_membership_signals').all()).toEqual([
      { chat_id: 'vk:2', generation: 2, signal_key: '8' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

test('переход первой схемы ко второй, история и повторный запуск', () => {
  const fixture = storageFixture();
  let db = new Database(fixture.path);
  try {
    migrate(db, migrations.slice(0, 1));
    db.exec(insert);
    db.exec(
      "INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES ('vk:1','mention','Europe/Moscow',0,0)",
    );
    db.close();
    db = new Database(fixture.path);
    migrate(db);
    expect(
      db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('старый'),
    ).toHaveLength(1);
    expect(db.prepare('SELECT enabled FROM chats').get()).toEqual({ enabled: 0 });
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations').all()).toEqual(before);
    expect(db.prepare('PRAGMA index_info(messages_chat_time)').all()).toMatchObject([
      { name: 'chat_id' },
      { name: 'timestamp' },
      { name: 'id' },
    ]);
  } finally {
    db.close();
    fixture.cleanup();
  }
});
for (const sql of [
  `UPDATE schema_migrations SET version = ${migrations.length + 1} WHERE version = ${migrations.length}`,
  'DELETE FROM schema_migrations WHERE version = 1',
  "UPDATE schema_migrations SET name = 'changed' WHERE version = 1",
  "UPDATE schema_migrations SET checksum = 'changed' WHERE version = 1",
]) {
  test(`отказ для изменённой истории: ${sql}`, () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(insert);
      db.exec(sql);
      const before = db.serialize();
      expect(() => migrate(db)).toThrow('schema_incompatible');
      expect(db.serialize()).toEqual(before);
    } finally {
      db.close();
    }
  });
}
test.each(['legacy', 'sqliteXlegacy'])('посторонняя БД с таблицей %s не меняется', (table) => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${table}(secret TEXT)`);
    const before = db.serialize();
    expect(() => migrate(db)).toThrow('schema_incompatible');
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
test('откат всего недостающего набора и сохранность предыдущей схемы', () => {
  const db = new Database(':memory:');
  try {
    migrate(db, migrations.slice(0, 1));
    db.exec(insert);
    const before = db.serialize();
    expect(() =>
      migrate(db, [
        ...migrations,
        {
          version: migrations.length + 1,
          name: 'broken',
          sql: 'CREATE TABLE partial(x); SECRET SQL;',
        },
      ]),
    ).toThrow('migration_failed');
    expect(db.serialize()).toEqual(before);
    expect(db.prepare('SELECT text FROM messages').get()).toEqual({ text: 'старый' });
  } finally {
    db.close();
  }
});
test('первичная ошибка также откатывает метаданные', () => {
  const db = new Database(':memory:');
  try {
    expect(() =>
      migrate(db, [{ version: 1, name: 'broken', sql: 'CREATE TABLE partial(x); BROKEN' }]),
    ).toThrow('migration_failed');
    expect(db.prepare('SELECT name FROM sqlite_schema').all()).toEqual([]);
  } finally {
    db.close();
  }
});
test('недоступный FTS-модуль: отказ миграции и закрытие соединения', async () => {
  let reference: Database.Database | undefined;
  await expect(
    openConnection(':memory:', (db) => {
      reference = db;
      migrate(db, [
        { version: 1, name: 'missing-fts', sql: 'CREATE VIRTUAL TABLE f USING missing_fts5(text)' },
      ]);
    }),
  ).rejects.toMatchObject({ code: 'migration_failed' });
  expect(reference?.open).toBe(false);
});
