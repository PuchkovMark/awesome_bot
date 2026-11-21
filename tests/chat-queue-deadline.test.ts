import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createChatQueue } from '../src/core/index.js';
import { scopeFor } from './helpers/connection-scope.js';
import { queueMessage,flushQueue } from './helpers/chat-queue.js';
test('общий срок обработчика 130 секунд, поздний успех не меняет сводку',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');let resolve!:(x:'completed')=>void;let signal!:AbortSignal;
 const q=createChatQueue({storage,handler:w=>{signal=w.signal;return new Promise(r=>{resolve=r;});}});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();
 await vi.advanceTimersByTimeAsync(129999);expect(signal.aborted).toBe(false);
 await vi.advanceTimersByTimeAsync(1);expect(signal.aborted).toBe(true);expect(q.stats().depthRunning).toBe(0);
 resolve('completed');await flushQueue();expect(q.stats()).toMatchObject({depthRunning:0,interrupted:0});await q.stop();expect(vi.getTimerCount()).toBe(0);
 }finally{await q.stop();await storage.close();vi.useRealTimers();}
});
test('потеря владения прекращает запуск, поздний результат старого владельца не фиксируется',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');
 const {queueBackend}=await import('../src/storage/queue-registry.js');let finish!:(x:'completed')=>void;
 const q=createChatQueue({storage,handler:()=>new Promise(r=>{finish=r;})});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();
 vi.setSystemTime(32000);const backend=queueBackend(storage);expect(backend.acquire('next',30000,10000)).toBe(1);
 finish('completed');await flushQueue();await expect(q.stop()).rejects.toMatchObject({code:'lost_ownership'});
 expect(backend.depth('next')).toMatchObject({depthRunning:0});backend.release('next');expect(vi.getTimerCount()).toBe(0);
 }finally{await storage.close();vi.useRealTimers();}
});

test.each([false,true])('задержанный таймер не пропускает просроченный результат, stop=%s',async stopping=>{
 vi.useFakeTimers();let mono=0;const clock=vi.spyOn(performance,'now').mockImplementation(()=>mono);
 const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');let resolve!:(x:'completed')=>void;
 const q=createChatQueue({storage,handler:()=>new Promise(r=>{resolve=r;})});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();
 const stopped=stopping?q.stop():undefined;mono=stopping?10001:130001;
 resolve('completed');await flushQueue();expect(await storage.queue.get(scope,1)).toMatchObject({outcome:stopping?'interrupted':'deadline_exceeded'});
 await (stopped??q.stop());expect(vi.getTimerCount()).toBe(0);
 }finally{clock.mockRestore();await q.stop();await storage.close();vi.useRealTimers();}
});
