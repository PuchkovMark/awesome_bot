import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createMessageRouter,createAgentLoopQueue,createPublicationService} from '../src/core/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {flushQueue} from './helpers/chat-queue.js';
import type {IncomingMessage} from '../src/contracts/index.js';
const message:IncomingMessage={kind:'message',chatId:'vk:a',userId:'vk:u',authorName:'',isGroupChat:true,isAdmin:false,isBot:false,text:'Пенек помоги',messageId:'1',isMentioned:false,isReplyToBot:false,timestamp:0,attachments:[]};
const prepare=async()=>({kind:'ready' as const,input:{system:'',messages:[{role:'user' as const,text:'hi'}],maxOutputTokens:5,sessionId:'opaque'}});
for(const mode of ['normal','active'] as const)for(const kind of ['complete','incomplete','refused','empty','rate_limit'] as const)test(`связка ${mode}/${kind}`,async()=>{
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');await storage.chats.create(scope,{responseMode:mode,enabled:true,createdAt:0});
 const publish=vi.fn(async()=>({kind:'delivered' as const,receipt:{messageId:'out',userId:'vk:bot' as const,authorName:'',timestamp:1}}));
 const publication=createPublicationService({storage,port:{async canReply(){return true;},publish}});
 const client={async complete(){return kind==='rate_limit'?{kind:'error' as const,code:'rate_limit' as const,message:'SECRET'}:kind==='complete'||kind==='incomplete'?{kind,text:'Ответ',usage:{input:0,output:0}}:{kind,usage:{input:0,output:0}};}};
 const q=createAgentLoopQueue({storage,prepare,client,onSettled:publication.onSettled});const router=createMessageRouter({storage,queue:q,onQueueFull:publication.queueFull});
 try{await q.start();await router.receive(scope,message);await flushQueue();
 expect(publish).toHaveBeenCalledTimes(mode==='active'&&kind!=='complete'?0:1);
 if(publish.mock.calls.length){expect((await storage.messages.list(scope,{limit:5}))).toHaveLength(2);expect((await storage.contextMessages.list(scope,{limit:5}))).toHaveLength(kind==='complete'?2:1);}
 }finally{await q.stop();await storage.close();}
});
test('режим меняется во время проверки reply: уведомление не отправляется',async()=>{
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');let release:()=>void=()=>{};const publish=vi.fn(async()=>({kind:'unknown' as const}));
 const publication=createPublicationService({storage,port:{canReply:()=>new Promise<boolean>(resolve=>{release=()=>resolve(true);}),publish}});
 const q=createAgentLoopQueue({storage,prepare,client:{async complete(){return {kind:'empty',usage:{input:0,output:0}};}},onSettled:publication.onSettled});
 try{await q.start();await createMessageRouter({storage,queue:q}).receive(scope,message);await flushQueue();await storage.chats.update(scope,{responseMode:'active'});release();await flushQueue();expect(publish).not.toHaveBeenCalled();}finally{await q.stop();await storage.close();}
});
test('server исчерпывает попытки в active без любого сообщения',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');await storage.chats.create(scope,{responseMode:'active',enabled:true,createdAt:0});
 const publish=vi.fn(async()=>({kind:'unknown' as const}));const client={complete:vi.fn(async()=>({kind:'error' as const,code:'server' as const,message:'SECRET'}))};
 const publication=createPublicationService({storage,port:{async canReply(){return true;},publish}});const q=createAgentLoopQueue({storage,prepare,client,onSettled:publication.onSettled});
 try{await q.start();await createMessageRouter({storage,queue:q}).receive(scope,message);await flushQueue();await vi.advanceTimersByTimeAsync(1000);expect(client.complete).toHaveBeenCalledTimes(2);expect(publish).not.toHaveBeenCalled();expect(await storage.queue.get(scope,1)).toMatchObject({state:'terminal',outcome:'failed'});}finally{await q.stop();await storage.close();vi.useRealTimers();}
});
test('queue_full и ошибка цикла делят период; дубль переполненного входа не повторяет уведомление',async()=>{
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');let release:(value:import('../src/llm/types.js').LlmResult)=>void=()=>{};let calls=0;
 const error={kind:'error',code:'rate_limit',message:'SECRET'} as const;
 const client={async complete(){if(++calls===1)return await new Promise<import('../src/llm/types.js').LlmResult>(r=>{release=r;});return error;}};
 const publish=vi.fn(async()=>({kind:'delivered' as const,receipt:{messageId:'notice',userId:'vk:bot' as const,authorName:'',timestamp:1}}));
 const publication=createPublicationService({storage,port:{async canReply(){return true;},publish}});const q=createAgentLoopQueue({storage,prepare,client,config:{maxQueuedPerChat:1},onSettled:publication.onSettled});const router=createMessageRouter({storage,queue:q,onQueueFull:publication.queueFull});
 try{await q.start();await router.receive(scope,message);await flushQueue();await router.receive(scope,{...message,messageId:'2'});expect((await router.receive(scope,{...message,messageId:'3'})).admission?.status).toBe('queue_full');expect(publish).toHaveBeenCalledOnce();
 expect((await router.receive(scope,{...message,messageId:'3'})).admission?.status).toBe('duplicate');release(error);await flushQueue();expect(publish).toHaveBeenCalledOnce();expect(await storage.messages.list(scope,{limit:10})).toHaveLength(4);expect(await storage.contextMessages.list(scope,{limit:10})).toHaveLength(3);
 }finally{release(error);await flushQueue();await q.stop();await storage.close();}
});
