import {expect,test} from 'vitest';
import Database from 'better-sqlite3';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {storageFixture} from './helpers/storage-fixture.js';
test('полный журнал сохраняет notice, контекст фильтрует до limit и get/reply; FTS rebuild безопасен',async()=>{
 const f=storageFixture(),s=await openStorage(f.path),scope=scopeFor(s,'vk:a'),db=new Database(f.path);
 try{
  const first=await s.messages.append(scope,{chatId:'vk:a',messageId:'a',userId:'vk:u',authorName:'',role:'user',text:'обычныйкот',timestamp:0});
  db.exec("INSERT INTO messages(chat_id,platform_message_id,user_id,author_name,role,text,timestamp,purpose) VALUES('vk:a','n','vk:bot','','assistant','уведомлениекот',1,'service_notice')");
  const all=await s.messages.list(scope,{limit:2});expect(all).toHaveLength(2);expect(all[1]?.purpose).toBe('service_notice');
  expect(await s.contextMessages.list(scope,{limit:1})).toMatchObject([{id:first.id}]);expect(await s.contextMessages.get(scope,all[1]!.id)).toBeNull();
  expect(await s.contextMessages.reply(scope,'n',all[1]!.id,100)).toBeNull();
  expect(await s.contextMessages.page(scope,{cutoffId:all[1]!.id,limit:1,textLimit:100})).toMatchObject([{id:first.id}]);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'уведомлениекот'").all()).toEqual([]);
  await expect(s.messages.append(scope,{chatId:'vk:a',messageId:'bad',userId:'vk:u',authorName:'',role:'user',text:'',timestamp:0,purpose:'service_notice'} as never)).rejects.toMatchObject({code:'invalid_input'});
 }finally{db.close();await s.close();f.cleanup();}
});
