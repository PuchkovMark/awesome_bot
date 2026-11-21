import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {createMessageRouter,createAgentLoopQueue,createPublicationService} from '../src/core/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {flushQueue} from './helpers/chat-queue.js';
import type {IncomingMessage} from '../src/contracts/index.js';
const message:IncomingMessage={kind:'message',chatId:'vk:a',userId:'vk:u',authorName:'',isGroupChat:true,isAdmin:false,isBot:false,text:'Пенек помоги',messageId:'1',isMentioned:false,isReplyToBot:false,timestamp:0,attachments:[]};
const prepare=async()=>({system:'',messages:[{role:'user' as const,text:'hi'}],maxOutputTokens:5,sessionId:'opaque'});
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
