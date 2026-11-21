import {expect,test} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
test('граница записи, курсор и ограниченная цитата независимо от timestamp',async()=>{
 const s=await openStorage(':memory:');try{
 const scope=scopeFor(s,'vk:a');const put=(messageId:string,timestamp:number,text='кот')=>s.messages.append(scope,{chatId:scope.chatId,userId:'vk:u',messageId,timestamp,text,authorName:'Имя',role:'user'});
 const a=await put('a',500,'😀'.repeat(100));const b=await put('b',600);await put('late',1);
 expect(await s.contextMessages.page(scope,{cutoffId:b.id,limit:1,textLimit:10})).toMatchObject([{id:b.id}]);
 const page=await s.contextMessages.page(scope,{cutoffId:b.id,beforeId:b.id,limit:1,textLimit:10});expect(page).toMatchObject([{id:a.id,truncated:true,text:'😀'.repeat(10)}]);
 expect(await s.contextMessages.reply(scope,'late',b.id,10)).toBeNull();
 expect(await s.contextMessages.reply(scope,'a',b.id,10)).toMatchObject({id:a.id,truncated:true});
 await expect(s.contextMessages.page({...scope} as never,{cutoffId:b.id,limit:1,textLimit:10})).rejects.toBeDefined();
 }finally{await s.close();}
});
