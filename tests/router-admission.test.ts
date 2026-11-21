import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createChatQueue} from '../src/core/chat-queue/service.js';
import {createMessageRouter} from '../src/core/message-router/service.js';
import {scopeFor} from './helpers/connection-scope.js';
import {flushQueue} from './helpers/chat-queue.js';
import type {IncomingMessage} from '../src/contracts/index.js';
const incoming:IncomingMessage={kind:'message',chatId:'vk:a',userId:'vk:u',authorName:'',isGroupChat:true,isAdmin:false,isBot:false,text:'Пенек помоги',messageId:'1',isMentioned:false,isReplyToBot:false,timestamp:0,attachments:[]};
test('роутер журналирует до решения, дубли не повторяются, silent/unknown не запускают обработчик',async()=>{
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a'),handler=vi.fn(async()=> 'completed' as const);const queue=createChatQueue({storage,handler});await queue.start();
 const onDecision=vi.fn(),router=createMessageRouter({storage,queue,onDecision});
 try{expect((await router.receive(scope,incoming)).decision?.kind).toBe('ordinary');await flushQueue();expect(handler).toHaveBeenCalledOnce();
 expect((await router.receive(scope,incoming)).admission?.status).toBe('duplicate');expect(onDecision).toHaveBeenCalledOnce();
 expect((await router.receive(scope,{...incoming,messageId:'unknown',isBot:'unknown'})).decision?.reason).toBe('sender_unknown');
 await storage.chats.update(scope,{responseMode:'silent'});expect((await router.receive(scope,{...incoming,messageId:'silent'})).decision?.reason).toBe('silent');expect(await storage.messages.list(scope,{limit:10})).toHaveLength(3);
 await storage.chats.update(scope,{enabled:false});expect((await router.receive(scope,{...incoming,messageId:'off'})).admission).toBeNull();expect(await storage.messages.list(scope,{limit:10})).toHaveLength(3);
 }finally{await queue.stop();await storage.close();}
});
