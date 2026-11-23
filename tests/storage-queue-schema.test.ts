import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';
test('миграция 7 сохраняет первые 6 версий и журнал без автоматических заданий', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  try {
    migrate(db, migrations.slice(0, 6));
    db.exec(
      "INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES ('vk:a',1,0,'active'),('vk:b',2,0,'active'); INSERT INTO messages VALUES (1,'vk:a','m','vk:u','','user','кот',NULL,0)",
    );
    const before = db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db, migrations.slice(0, 7));
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=6').all()).toEqual(before);
    expect(
      db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?').all('кот'),
    ).toHaveLength(1);
    expect(db.prepare('SELECT * FROM queue_jobs').all()).toEqual([]);
    expect(() =>
      db.exec("INSERT INTO queue_jobs VALUES(1,'vk:b',2,1,0,100,'queued',NULL,NULL)"),
    ).toThrow();
    expect(() =>
      db.exec("INSERT INTO queue_jobs VALUES(1,'vk:a',2,1,0,100,'queued',NULL,NULL)"),
    ).toThrow();
    db.exec("INSERT INTO queue_jobs VALUES(1,'vk:a',1,1,0,100,'queued',NULL,NULL)");
    expect(() => db.exec("UPDATE queue_jobs SET state='terminal' WHERE id=1")).toThrow();
    const columns = db.pragma('table_info(queue_jobs)') as { name: string }[];
    expect(columns.map((c) => c.name)).not.toContain('text');
    db.exec('DELETE FROM messages');
    expect(db.prepare('SELECT * FROM queue_jobs').all()).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
