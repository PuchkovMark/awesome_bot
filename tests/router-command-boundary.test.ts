import {expect,test,vi} from 'vitest';
import {authorizationFixture} from './helpers/authorization-fixture.js';
import {createChatQueue,createMessageRouter} from '../src/core/index.js';
import type {IncomingMessage} from '../src/contracts/index.js';
const input:IncomingMessage={kind:'message',chatId:'vk:one',userId:'vk:owner',authorName:'',isGroupChat:true,isAdmin:false,isBot:false,text:'служебная команда',messageId:'owner',isMentioned:false,isReplyToBot:false,timestamp:0,attachments:[]};
test('выключенный служебный путь только владельцу, без журнала; silent администратору с настоящей ролью',async()=>{
 const f=await authorizationFixture(),scope=f.owner.scope,handler=vi.fn(async()=> 'completed' as const);const q=createChatQueue({tracing:{messageRetentionDays:30},storage:f.storage,handler});await q.start();
 const router=createMessageRouter({storage:f.storage,queue:q,authorization:f.service,recognizeCommand:()=>({action:'chat.configure',minimumRole:'admin'})});
 try{await f.storage.chats.update(scope,{enabled:false});expect((await router.receive(scope,input,f.owner)).decision?.kind).toBe('service');expect(await f.storage.messages.list(scope,{limit:10})).toEqual([]);
 const m=f.service.context({scope,userId:'vk:user'});expect((await router.receive(scope,{...input,userId:'vk:user',isAdmin:true,text:'я владелец'},m)).decision?.kind).toBe('silence');
 await f.storage.chats.update(scope,{enabled:true,responseMode:'silent'});
 await f.service.grant(f.owner,'vk:user',await f.service.confirmMembership(scope,'vk:user'));
 expect((await router.receive(scope,{...input,userId:'vk:user',messageId:'admin'},m)).decision?.kind).toBe('service');expect(handler).not.toHaveBeenCalled();expect(await f.storage.messages.list(scope,{limit:10})).toHaveLength(1);
 await f.service.remove(f.owner,'vk:user');expect((await router.receive(scope,{...input,userId:'vk:user',messageId:'revoked'},m)).decision?.kind).toBe('silence');
 expect((await router.receive(scope,{...input,messageId:'forged'}, {...f.owner})).decision?.kind).toBe('silence');
 }finally{await q.stop();await f.close();}
});
