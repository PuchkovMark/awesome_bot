import {expect,test,vi} from 'vitest';
import {openStorage} from '../src/storage/index.js';
import {queueBackend} from '../src/storage/queue-registry.js';
import {queueConfig} from '../src/core/chat-queue/validation.js';
import {createChatQueue} from '../src/core/chat-queue/service.js';
import {storageFixture} from './helpers/storage-fixture.js';
import {scopeFor} from './helpers/connection-scope.js';
import {queueMessage,flushQueue} from './helpers/chat-queue.js';
const route={kind:'mention',mode:'active',isGroupChat:true} as const;
test('routed callback видит согласованные настройки, async откатывает, перезапуск сохраняет маршрут',async()=>{
 const f=storageFixture();let s=await openStorage(f.path);
 try{const scope=scopeFor(s,'vk:a');await s.chats.create(scope,{enabled:true,responseMode:'active',createdAt:0});const backend=queueBackend(s);backend.acquire('o',30000,10000);
 const callback=vi.fn(snapshot=>{expect(Object.isFrozen(snapshot.settings)).toBe(true);expect(snapshot.settings.responseMode).toBe('active');return {reason:'mention' as const,route};});
 expect(backend.admitRouted('o',scope,queueMessage('vk:a','1'),callback,queueConfig()).admission.status).toBe('queued');
 backend.admitRouted('o',scope,queueMessage('vk:a','1'),callback,queueConfig());expect(callback).toHaveBeenCalledOnce();
 expect(()=>backend.admitRouted('o',scope,queueMessage('vk:a','bad'),(async()=>({reason:'mention',route})) as never,queueConfig())).toThrow('invalid_input');expect(await s.messages.list(scope,{limit:10})).toHaveLength(1);
 backend.release('o');await s.close();s=await openStorage(f.path);const seen=vi.fn(async(work)=>{expect(work.route).toEqual(route);});
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage:s,handler:async()=> 'completed',onSettled:seen});await q.start();await flushQueue();expect(seen).toHaveBeenCalledOnce();await q.stop();
 }finally{await s.close();f.cleanup();}
});
