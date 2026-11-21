import Database from 'better-sqlite3';
import { expect, test } from 'vitest';
import { migrate } from '../src/storage/migrate.js';
import { migrations } from '../src/storage/migrations/index.js';
import { advanceClock } from '../src/storage/lifecycle-clock.js';

test('счётчик независим от чатов по схеме; миграция сохраняет версию 4 с журналом без настроек', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  try {
    migrate(db, migrations.slice(0,4));
    db.exec("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES ('vk:1','1','vk:2','','user','кот',0)");
    const before=db.prepare('SELECT * FROM schema_migrations').all();
    migrate(db);
    expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=4').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM chat_connections').get()).toMatchObject({chat_id:'vk:1',state:'uncertain'});
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'кот'").all()).toHaveLength(1);
    expect((db.pragma('table_info(lifecycle_clock)') as {name:string}[]).map(r=>r.name)).toEqual(['singleton','value']);
    const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[];
    for(const {name} of tables) {
      const fks=db.pragma(`foreign_key_list('${name}')`) as {table:string}[];
      expect(fks.some(f=>f.table==='lifecycle_clock')).toBe(false);
      if(name==='lifecycle_clock')expect(fks).toEqual([]);
    }
    expect(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND sql LIKE '%lifecycle_clock%'").all()).toEqual([]);
    expect(db.transaction(()=>advanceClock(db))()).toBe(2);
    db.exec('UPDATE lifecycle_clock SET value=9007199254740991');
    expect(()=>db.transaction(()=>advanceClock(db))()).toThrow('operation_failed');
  } finally {db.close();}
});
