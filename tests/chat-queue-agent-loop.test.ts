import { expect,test,vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { createAgentLoopQueue } from '../src/core/index.js';
import { scopeFor } from './helpers/connection-scope.js';
import { queueMessage,flushQueue } from './helpers/chat-queue.js';
const prepare=async()=>({kind:'ready' as const,input:{system:'',messages:[{role:'user' as const,text:'private'}],maxOutputTokens:1,sessionId:'opaque'}});
test('rate_limit конечен, server повторяется только внутри цикла, очередь продолжает',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:');const scope=scopeFor(storage,'vk:a');
 let calls=0;const q=createAgentLoopQueue({storage,prepare,client:{async complete(){calls++;if(calls===1)return{kind:'error',code:'rate_limit',message:'private'};if(calls===2)return{kind:'error',code:'server',message:'private'};return{kind:'complete',text:'private',usage:{input:0,output:0}};}}});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();
 await q.admit(scope,queueMessage('vk:a','2'),()=>true);await flushQueue();expect(calls).toBe(2);
 await vi.advanceTimersByTimeAsync(1000);expect(calls).toBe(3);expect(await storage.queue.get(scope,1)).toMatchObject({state:'terminal',outcome:'rate_limit'});expect(await storage.queue.get(scope,2)).toMatchObject({state:'terminal',outcome:'completed'});
 await vi.advanceTimersByTimeAsync(5000);expect(calls).toBe(3);
 }finally{await q.stop();await storage.close();vi.useRealTimers();}
});
test('фактический изменённый срок F2.2 связан с бюджетом обработчика, несовместимость отклоняется',async()=>{
 const storage=await openStorage(':memory:');try{
 expect(()=>createAgentLoopQueue({storage,prepare,client:{async complete(){return{kind:'empty',usage:{input:0,output:0}};}},loopOptions:{timeoutMs:200000},config:{handlerTimeoutMs:130000}})).toThrow('invalid_input');
 }finally{await storage.close();}
});
test('на границе срока цикла очередь ещё не прерывает обработчик',async()=>{
 vi.useFakeTimers();const storage=await openStorage(':memory:');const scope=scopeFor(storage,'vk:a');
 const q=createAgentLoopQueue({storage,prepare,loopOptions:{timeoutMs:200000},client:{complete:()=>new Promise(()=>{})}});
 try{
 await q.start();await q.admit(scope,queueMessage('vk:a','1'),()=>true);await flushQueue();await vi.advanceTimersByTimeAsync(199999);
 expect(q.stats().depthRunning).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(await storage.queue.get(scope,1)).toMatchObject({outcome:'deadline_exceeded'});expect(q.stats().interrupted).toBe(0);
 }finally{await q.stop();await storage.close();vi.useRealTimers();}
});
