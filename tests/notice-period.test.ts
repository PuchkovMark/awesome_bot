import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {noticeBackend} from '../src/storage/notice-store.js';
import {noticeInterval} from '../src/core/message-router/notice-config.js';
import {scopeFor} from './helpers/connection-scope.js';
import {queueMessage} from './helpers/chat-queue.js';
import {storageFixture} from './helpers/storage-fixture.js';
const route={kind:'name',mode:'normal',isGroupChat:true} as const;
test('период, подтверждение, коллизия и отсутствие в контексте',async()=>{
 const s=await openStorage(':memory:'),scope=scopeFor(s,'vk:a');try{
 await s.chats.create(scope,{responseMode:'normal',enabled:true,createdAt:0});const input=await s.messages.append(scope,queueMessage('vk:a','1'));const backend=noticeBackend(s);
 const permit=backend.reserve(scope,input.id,route,100,0)!;expect(permit).not.toBeNull();expect(backend.reserve(scope,input.id,route,100,99)).toBeNull();
 const receipt={messageId:'notice',userId:'vk:bot' as const,authorName:'',timestamp:1};backend.confirm(scope,permit,receipt);backend.confirm(scope,permit,receipt);
 expect(await s.messages.list(scope,{limit:5})).toHaveLength(2);expect(await s.contextMessages.list(scope,{limit:5})).toHaveLength(1);
 expect(()=>backend.confirm(scope,{} as never,receipt)).toThrow('invalid_input');
 expect(backend.reserve(scope,input.id,route,100,100)).not.toBeNull();expect(backend.reserve(scope,input.id,route,100,1)).toBeNull();
 expect(()=>backend.reserve(scope,input.id,route,100,Number.MAX_SAFE_INTEGER)).toThrow('invalid_input');
 await s.chats.update(scope,{responseMode:'active'});expect(backend.reserve(scope,input.id,route,100,1000)).toBeNull();
 }finally{await s.close();}
});
test('два соединения и перезапуск не сбрасывают резерв',async()=>{
 const f=storageFixture();let a=await openStorage(f.path);let b=await openStorage(f.path);
 try{const x=scopeFor(a,'vk:a'),y=scopeFor(b,'vk:a');await a.chats.create(x,{responseMode:'normal',enabled:true,createdAt:0});const m=await a.messages.append(x,queueMessage('vk:a','1'));
 const results=await Promise.all([Promise.resolve().then(()=>noticeBackend(a).reserve(x,m.id,route,100,0)),Promise.resolve().then(()=>noticeBackend(b).reserve(y,m.id,route,100,0))]);expect(results.filter(Boolean)).toHaveLength(1);
 await a.close();await b.close();a=await openStorage(f.path);b=await openStorage(f.path);expect(noticeBackend(a).reserve(scopeFor(a,'vk:a'),m.id,route,100,99)).toBeNull();
 }finally{await a.close();await b.close();f.cleanup();}
});
test('настройка только положительное безопасное целое',()=>{expect(noticeInterval()).toBe(300000);for(const x of [0,-1,NaN,Infinity,'1',1.5])expect(()=>noticeInterval(x)).toThrow('invalid_configuration');vi.restoreAllMocks();});
