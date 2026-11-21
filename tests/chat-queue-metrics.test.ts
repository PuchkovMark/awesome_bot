import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createChatQueue } from '../src/core/index.js';
import { createLogger } from '../src/logger/index.js';
import { scopeFor } from './helpers/connection-scope.js';
import { queueMessage,flushQueue } from './helpers/chat-queue.js';
test('логи содержат только счётчики, повтор перехода не удваивает interrupted',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:');const scope=scopeFor(storage,'vk:secret-chat');const lines:string[]=[];
 const logger=createLogger({destination:{write(line){lines.push(line);}}});
 const q=createChatQueue({storage,logger,config:{maxQueuedPerChat:1},handler:()=>new Promise(()=>{})});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:secret-chat','private1'),()=>true);await flushQueue();
 await q.admit(scope,queueMessage('vk:secret-chat','private2'),()=>true);await q.admit(scope,queueMessage('vk:secret-chat','private3'),()=>true);
 expect(q.stats()).toMatchObject({depthQueued:1,depthRunning:1,rejected:1});const p=q.stop();await vi.advanceTimersByTimeAsync(10000);await p;
 expect(q.stats().interrupted).toBe(1);await q.stop();expect(q.stats().interrupted).toBe(1);
 expect(lines.join('')).not.toMatch(/private|secret-chat|chatId|messageId|sessionId/);expect(lines.map(l=>JSON.parse(l)).at(-1)).toMatchObject({event:'queue_stats',window:'run',interrupted:1});
 }finally{await q.stop();await storage.close();vi.useRealTimers();}
});
test('сбой логгера не меняет обработку',async()=>{
 const storage=await openStorage(':memory:');const logger=createLogger({destination:{write(){throw Error('private');}}});
 const q=createChatQueue({storage,logger,handler:async()=> 'completed'});try{
 await q.start();const scope=scopeFor(storage,'vk:a');await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();expect(q.stats().depthRunning).toBe(0);
 }finally{await q.stop();await storage.close();}
});
