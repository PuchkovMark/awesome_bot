import Database from 'better-sqlite3';
import {expect,test} from 'vitest';
import {migrate} from '../src/storage/migrate.js';
import {migrations} from '../src/storage/migrations/index.js';

test('версия 7 сохраняет данные, FK и checksums; оба режима становятся normal',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');
 try{
  migrate(db,migrations.slice(0,7));
  db.exec(`INSERT INTO chats(chat_id,response_mode,timezone,enabled,created_at) VALUES ('vk:a','always','UTC',0,0),('vk:b','mention','UTC',1,0);
   INSERT INTO chat_connections(chat_id,generation,revision,state) VALUES('vk:a',1,0,'active');
   INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:a','1','vk:u','','user','проверка',0);
   INSERT INTO queue_jobs(chat_id,generation,message_id,received_at,expires_at,state) VALUES('vk:a',1,1,0,100,'queued');`);
  const history=db.prepare('SELECT * FROM schema_migrations').all();const jobs=db.prepare('SELECT * FROM queue_jobs').all();
  migrate(db);expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=7').all()).toEqual(history);
  expect(db.prepare('SELECT response_mode,enabled FROM chats ORDER BY chat_id').all()).toEqual([{response_mode:'normal',enabled:0},{response_mode:'normal',enabled:1}]);
  expect(db.prepare('SELECT * FROM queue_jobs').all()).toMatchObject(jobs);expect(db.pragma('foreign_key_check')).toEqual([]);
  db.exec("UPDATE messages SET purpose='service_notice'; INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'проверка'").all()).toEqual([]);
  db.exec("UPDATE messages SET purpose='conversation'");expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'проверка'").all()).toHaveLength(1);
  migrate(db);
 }finally{db.close();}
});
