import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index';
import { createChatQueue } from '../src/core/index';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { scopeFor } from './helpers/connection-scope';
import { queueMessage,flushQueue } from './helpers/chat-queue';
test('uncertain отменяет текущий результат, queued продолжает только после решения владельца',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:');const life=lifecycleBackend(storage),scope=scopeFor(storage,'vk:a');
 const signals:AbortSignal[]=[];const release:(()=>void)[]=[];
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage,handler:async w=>{signals.push(w.signal);await new Promise<void>(r=>release.push(r));return 'completed';}});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();await q.admit(scope,queueMessage('vk:a','2'),()=>true);
 life.apply(life.begin('vk:a'),{confidence:'unavailable',bot:'unknown'});await vi.advanceTimersByTimeAsync(1000);
 expect(signals[0]!.aborted).toBe(true);expect(q.stats()).toMatchObject({interrupted:1,depthQueued:1,depthRunning:0});
 life.ownerDecision(life.begin('vk:a'),'continue');await vi.advanceTimersByTimeAsync(1000);expect(signals).toHaveLength(2);
 release.forEach(r=>r());await flushQueue();expect(q.stats().depthRunning).toBe(0);
 }finally{const p=q.stop();await vi.advanceTimersByTimeAsync(10000);await p;await storage.close();vi.useRealTimers();}
});

test('удаление текущего поколения отменяет локальную работу, поздний результат не попадает в новое',async()=>{
 const storage=await openStorage(':memory:'),life=lifecycleBackend(storage),old=scopeFor(storage,'vk:a');
 const release:(()=>void)[]=[],signals:AbortSignal[]=[];
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage,config:{maxConcurrentChats:1},handler:async w=>{signals.push(w.signal);await new Promise<void>(r=>release.push(r));return 'completed';}});
 try{
 await q.start();await q.admit(old,queueMessage('vk:a','1'),()=>true);await flushQueue();await q.admit(old,queueMessage('vk:a','2'),()=>true);
 life.apply(life.begin('vk:a'),{confidence:'confirmed',bot:'absent'});
 const fresh=scopeFor(storage,'vk:a');expect(fresh.generation).not.toBe(old.generation);
 await q.admit(fresh,queueMessage('vk:a','new'),()=>true);await flushQueue();expect(signals[0]!.aborted).toBe(true);expect(signals).toHaveLength(2);
 release[0]!();await flushQueue();expect(q.stats().depthRunning).toBe(1);expect(await storage.queue.get(fresh,1)).toBeNull();
 release[1]!();await flushQueue();expect((await storage.messages.list(fresh,{limit:10})).map(m=>m.text)).toEqual(['new']);
 }finally{await q.stop();await storage.close();}
});

test('просроченный маркер не блокирует очистку без нового запуска очереди',async()=>{
 vi.useFakeTimers();vi.setSystemTime(1000);const storage=await openStorage(':memory:'),scope=scopeFor(storage,'vk:a');
 const {queueBackend}=await import('../src/storage/queue-registry');
 try{
 await storage.messages.append(scope,queueMessage('vk:a','1'));queueBackend(storage).acquire('crashed',100,10);vi.setSystemTime(1100);
 const life=lifecycleBackend(storage);expect(life.apply(life.begin('vk:a'),{confidence:'confirmed',bot:'absent'})).toMatchObject({status:'applied'});
 expect(()=>life.current('vk:a')).toThrow('stale_scope');
 }finally{await storage.close();vi.useRealTimers();}
});
