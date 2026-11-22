import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {migrate} from '../src/storage/migrate.js';
import {migrations} from '../src/storage/migrations/index.js';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {storageFixture} from './helpers/storage-fixture.js';
test('upgrade 8 сохраняет контрольные суммы, тексты и FTS; старый признак неизвестен',()=>{
 const db=new Database(':memory:');try{
 migrate(db,migrations.slice(0,8));const before=db.prepare('SELECT * FROM schema_migrations').all();
 db.exec("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp) VALUES('vk:a','1','vk:u','','user','кот',0)");
 migrate(db,migrations.slice(0,9));expect(db.prepare('SELECT * FROM schema_migrations WHERE version<=8').all()).toEqual(before);
 expect(db.prepare('SELECT attachment_count FROM messages').get()).toEqual({attachment_count:null});
 expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'кот'").all()).toHaveLength(1);
 expect(db.prepare('PRAGMA table_info(chats)').all()).toContainEqual(expect.objectContaining({name:'system_prompt'}));
 }finally{db.close();}
});
test('вложение сохраняется при перезапуске, дубликат не переписывает его',async()=>{
 const f=storageFixture();let s=await openStorage(f.path);try{
 let scope=scopeFor(s,'vk:a');const input={chatId:'vk:a',messageId:'1',userId:'vk:u',authorName:'',role:'user',text:'',timestamp:0,attachmentCount:1} as const;
 const a=await s.messages.append(scope,input);await s.messages.append(scope,{...input,attachmentCount:2});
 await expect(s.messages.append(scope,{...input,messageId:'bad',attachmentCount:-1})).rejects.toMatchObject({code:'invalid_input'});
 await s.close();s=await openStorage(f.path);scope=scopeFor(s,'vk:a');expect(await s.messages.get(scope,a.id)).toMatchObject({attachmentCount:1});
 }finally{await s.close();f.cleanup();}
});
