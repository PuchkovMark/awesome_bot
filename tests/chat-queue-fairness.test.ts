import { expect,test } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createChatQueue } from '../src/core/index.js';
import { scopeFor } from './helpers/connection-scope.js';
import { queueMessage,flushQueue } from './helpers/chat-queue.js';
test('циклический выбор даёт тихому чату слот раньше нового задания горячего',async()=>{
 const storage=await openStorage(':memory:');const a=scopeFor(storage,'vk:a'),b=scopeFor(storage,'vk:b');
 const calls:string[]=[];const releases:(()=>void)[]=[];
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage,config:{maxConcurrentChats:1},handler:async w=>{calls.push(w.scope.chatId);await new Promise<void>(r=>releases.push(r));return 'completed';}});
 try{
 await q.start();await q.admit(a,queueMessage('vk:a','1'),()=>true);await flushQueue();
 await q.admit(a,queueMessage('vk:a','2'),()=>true);await q.admit(b,queueMessage('vk:b','1'),()=>true);
 releases[0]!();await flushQueue();expect(calls).toEqual(['vk:a','vk:b']);
 releases[1]!();await flushQueue();expect(calls).toEqual(['vk:a','vk:b','vk:a']);releases[2]!();await flushQueue();
 }finally{await q.stop();await storage.close();}
});
test('пятый чат ждёт освобождения одного из четырёх слотов',async()=>{
 const storage=await openStorage(':memory:');const releases:(()=>void)[]=[];
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage,handler:async()=>{await new Promise<void>(r=>releases.push(r));return 'completed';}});
 try{
 await q.start();for(let i=0;i<5;i++){const id=`vk:${i}` as const;await q.admit(scopeFor(storage,id),queueMessage(id,'1'),()=>true);await flushQueue();}
 expect(releases).toHaveLength(4);expect(q.stats()).toMatchObject({depthRunning:4,depthQueued:1});
 releases[0]!();await flushQueue();expect(releases).toHaveLength(5);for(const r of releases)r();await flushQueue();
 }finally{await q.stop();await storage.close();}
});

test('новый чат не обгоняет уже готовый чат, который обслуживался раньше',async()=>{
 const storage=await openStorage(':memory:');const calls:string[]=[],release:(()=>void)[]=[];
 const q=createChatQueue({tracing:{messageRetentionDays:30},storage,config:{maxConcurrentChats:1},handler:async w=>{calls.push(w.scope.chatId);await new Promise<void>(r=>release.push(r));return 'completed';}});
 try{
 await q.start();const b=scopeFor(storage,'vk:b'),a=scopeFor(storage,'vk:a'),c=scopeFor(storage,'vk:c');
 await q.admit(b,queueMessage('vk:b','old'),()=>true);await flushQueue();release[0]!();await flushQueue();
 await q.admit(a,queueMessage('vk:a','busy'),()=>true);await flushQueue();
 await q.admit(b,queueMessage('vk:b','waiting'),()=>true);await q.admit(c,queueMessage('vk:c','new'),()=>true);
 release[1]!();await flushQueue();expect(calls).toEqual(['vk:b','vk:a','vk:b']);
 release[2]!();await flushQueue();expect(calls.at(-1)).toBe('vk:c');release[3]!();await flushQueue();
 }finally{await q.stop();await storage.close();}
});
