import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createChatQueue } from '../src/core/index.js';
import { lifecycleBackend } from '../src/storage/lifecycle-store.js';
import { scopeFor } from './helpers/connection-scope.js';
import { queueMessage,flushQueue } from './helpers/chat-queue.js';
test('uncertain отменяет текущий результат, queued продолжает только после решения владельца',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:');const life=lifecycleBackend(storage),scope=scopeFor(storage,'vk:a');
 const signals:AbortSignal[]=[];const release:(()=>void)[]=[];
 const q=createChatQueue({storage,handler:async w=>{signals.push(w.signal);await new Promise<void>(r=>release.push(r));return 'completed';}});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();await q.admit(scope,queueMessage('vk:a','2'),()=>true);
 life.apply(life.begin('vk:a'),{confidence:'unavailable',bot:'unknown'});await vi.advanceTimersByTimeAsync(1000);
 expect(signals[0]!.aborted).toBe(true);expect(q.stats()).toMatchObject({interrupted:1,depthQueued:1,depthRunning:0});
 life.ownerDecision(life.begin('vk:a'),'continue');await vi.advanceTimersByTimeAsync(1000);expect(signals).toHaveLength(2);
 release.forEach(r=>r());await flushQueue();expect(q.stats().depthRunning).toBe(0);
 }finally{const p=q.stop();await vi.advanceTimersByTimeAsync(10000);await p;await storage.close();vi.useRealTimers();}
});
