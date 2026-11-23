import Database from 'better-sqlite3';
import { expect,test } from 'vitest';
import { migrate } from '../src/storage/migrate';
import { migrations } from '../src/storage/migrations/index';

test('миграция 19 добавляет учёт, сохраняя журнал, окно уведомлений и контрольные суммы',()=>{
 const db=new Database(':memory:');
 try {
  migrate(db,migrations.slice(0,18));
  const history=db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  db.exec(`INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:2000000001',1,0,'active');
    INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp)
      VALUES('vk:2000000001','2','vk:2','','user','Журнал',100);
    INSERT INTO notice_periods(chat_id,generation,next_at) VALUES('vk:2000000001',1,150);`);
  migrate(db);
  expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=18 ORDER BY version').all()).toEqual(history);
  expect(db.prepare('SELECT name FROM schema_migrations WHERE version=19').pluck().get()).toBe('response-rate-and-flood');
  expect(db.prepare('SELECT text FROM messages').pluck().get()).toBe('Журнал');
  expect(db.prepare('SELECT next_at FROM notice_periods').pluck().get()).toBe(150);
  expect(db.pragma('foreign_key_check')).toEqual([]);
 } finally {db.close();}
});
