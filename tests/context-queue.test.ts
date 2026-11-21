import {expect,test,vi} from 'vitest';
import {contextFixture} from './helpers/context.js';
import {flushQueue,queueMessage} from './helpers/chat-queue.js';
import {createAgentLoopQueue} from '../src/core/chat-queue/agent-loop-adapter.js';
test('отказ подготовки не вызывает клиент и сохраняется отдельно от результата цикла',async()=>{
 const f=await contextFixture();const complete=vi.fn();const settled=vi.fn();const q=createAgentLoopQueue({storage:f.storage,client:{complete},prepare:async()=>({kind:'failed',reason:'current_message_too_large'}),onSettled:settled});
 try{await q.start();await q.admit(f.scope,queueMessage(f.scope.chatId,'a'),()=>true);await flushQueue();expect(complete).not.toHaveBeenCalled();expect(settled.mock.calls[0]?.[1]).toEqual({outcome:'failed',preparationFailure:'current_message_too_large'});expect(await f.storage.queue.get(f.scope,1)).toMatchObject({state:'terminal',outcome:'failed'});}finally{await q.stop();await f.storage.close();}
});
test('выключение между подготовкой и циклом блокирует клиент непосредственно перед запуском',async()=>{
 const f=await contextFixture();const complete=vi.fn();const q=createAgentLoopQueue({storage:f.storage,client:{complete},prepare:async()=>{await f.storage.chats.update(f.scope,{enabled:false});return {kind:'ready',input:{system:'',messages:[{role:'user',text:'x'}],maxOutputTokens:1,sessionId:'session'}};}});
 try{await q.start();await q.admit(f.scope,queueMessage(f.scope.chatId,'a'),()=>true);await flushQueue();expect(complete).not.toHaveBeenCalled();expect(await f.storage.queue.get(f.scope,1)).toMatchObject({outcome:'interrupted'});}finally{await q.stop();await f.storage.close();}
});
test('зависший prepare имеет отдельный срок, просроченное ready не запускает модель',async()=>{
 vi.useFakeTimers();const f=await contextFixture();const complete=vi.fn();let release:(v:never)=>void=()=>{};
 const q=createAgentLoopQueue({storage:f.storage,client:{complete},preparationTimeoutMs:5,prepare:()=>new Promise(resolve=>{release=resolve;})});
 try{await q.start();await q.admit(f.scope,queueMessage(f.scope.chatId,'a'),()=>true);await flushQueue();await vi.advanceTimersByTimeAsync(5);expect(await f.storage.queue.get(f.scope,1)).toMatchObject({outcome:'deadline_exceeded'});release({kind:'ready',input:{}} as never);await flushQueue();expect(complete).not.toHaveBeenCalled();}finally{await q.stop();await f.storage.close();vi.useRealTimers();}
});
