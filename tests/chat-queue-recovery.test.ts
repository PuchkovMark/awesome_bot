import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index';
import { createChatQueue } from '../src/core/index';
import { queueConfig } from '../src/core/chat-queue/validation';
import { queueBackend } from '../src/storage/queue-registry';
import { scopeFor } from './helpers/connection-scope';
import { storageFixture } from './helpers/storage-fixture';
import { queueMessage,flushQueue } from './helpers/chat-queue';
test('running после перезапуска конечен без повтора, queued сохраняет исходное поколение',async()=>{
 const f=storageFixture();let storage=await openStorage(f.path);let q:ReturnType<typeof createChatQueue>|undefined;
 try{
 const scope=scopeFor(storage,'vk:a'),backend=queueBackend(storage);backend.acquire('old',30000,10000);
 backend.admit('old',scope,queueMessage('vk:a','running'),()=>true,queueConfig());backend.take('old');
 backend.admit('old',scope,queueMessage('vk:a','waiting'),()=>true,queueConfig());backend.release('old');await storage.close();storage=await openStorage(f.path);
 const seen:string[]=[];q=createChatQueue({tracing:{messageRetentionDays:30},storage,handler:async w=>{expect(w.scope.generation).toBe(scope.generation);seen.push((await storage.messages.get(w.scope,w.messageId))!.text);return 'completed';}});
 await q.start();await flushQueue();expect(seen).toEqual(['waiting']);expect(q.stats().interrupted).toBe(1);
 }finally{await q?.stop();await storage.close();f.cleanup();}
});
test('граница срока ожидания не вызывает обработчик, возраст не сброшен',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const storage=await openStorage(':memory:');let q:ReturnType<typeof createChatQueue>|undefined;
 try{
 const scope=scopeFor(storage,'vk:a'),b=queueBackend(storage);b.acquire('old',30000,10000);
 b.admit('old',scope,queueMessage('vk:a','1'),()=>true,queueConfig({maxQueueAgeMs:100}));b.release('old');vi.setSystemTime(1100);
 const handler=vi.fn(async()=> 'completed' as const);q=createChatQueue({tracing:{messageRetentionDays:30},storage,handler});await q.start();await flushQueue();expect(handler).not.toHaveBeenCalled();expect(q.stats()).toMatchObject({expired:1,depthQueued:0,waitCount:1,waitTotalMs:100});
 }finally{await q?.stop();await storage.close();vi.useRealTimers();}
});
