import {expect,test,vi} from 'vitest';
import {contextFixture} from './helpers/context.js';
import {createContextPreparation} from '../src/core/prepare-context.js';
import {createAgentLoopQueue} from '../src/core/chat-queue/agent-loop-adapter.js';
import {flushQueue,queueMessage} from './helpers/chat-queue.js';
test('трассировка сохраняет использованный снимок, имя модели и usage без текста',async()=>{
 const f=await contextFixture();const prep=createContextPreparation({...f.options,storage:f.storage});let inputVersion=0;
 const q=createAgentLoopQueue({modelName:'test-model',tracing:{messageRetentionDays:30},storage:f.storage,prepare:async work=>{
 const r=await prep.prepare(work);if(r.kind==='ready'){inputVersion=r.metadata.version.version;const v=await f.admin.append({kind:'system_prompt',key:'base',text:'SECRET_NEW',createdAt:1,expectedHead:1});if(v.status==='created'&&v.value.ref.area==='global')await f.admin.selectSystemPrompt(v.value.ref,r.metadata.version);await f.put('late','SECRET_LATE');}return r;
 },client:{async complete(){return {kind:'complete',text:'SECRET_ANSWER',usage:{input:7,output:3}};}}});
 try{await q.start();await q.admitRouted(f.scope,queueMessage(f.scope.chatId,'trigger'),()=>({reason:'mention',route:{kind:'mention',mode:'normal',isGroupChat:true}}));await flushQueue();await flushQueue();const t=await f.storage.traces.get(f.scope,1);expect(t?.payload.prompt?.version).toBe(inputVersion);expect(t?.payload.context?.messageIds).toEqual([1]);expect(t?.payload.model).toEqual({name:'test-model',invoked:'yes'});expect(t?.payload.summary?.usage.input.knownTokens).toBe(7);expect(JSON.stringify(t)).not.toMatch(/SECRET_/);}finally{await q.stop();await f.storage.close();}
});
test('прерванный вызов имеет неизвестный расход, отказ подготовки — нулевой',async()=>{
 vi.useFakeTimers();const f=await contextFixture();const q=createAgentLoopQueue({modelName:'test-model',tracing:{messageRetentionDays:30},storage:f.storage,prepare:async()=>({kind:'ready',input:{system:'x',messages:[{role:'user',text:'SECRET'}],maxOutputTokens:1,sessionId:'SECRET'}}),client:{complete:()=>new Promise(()=>{})}});
 try{await q.start();await q.admitRouted(f.scope,queueMessage(f.scope.chatId,'m'),()=>({reason:'name',route:{kind:'name',mode:'normal',isGroupChat:true}}));await flushQueue();const running=await f.storage.traces.get(f.scope,1);expect(running?.payload.model.invoked).toBe('possible');expect(running?.payload.summary?.usage.input.unknownAttempts).toBe(1);await vi.advanceTimersByTimeAsync(130000);expect((await f.storage.traces.get(f.scope,1))?.payload.summary?.usage.input.unknownAttempts).toBe(1);expect((await f.storage.traces.get(f.scope,1))?.payload.publication).toMatchObject({rowId:'unsuccessful',reaction:'silence',status:'suppressed'});}finally{await q.stop();await f.storage.close();vi.useRealTimers();}
});
test('отсутствие порта имеет конечное решение молчать',async()=>{
 const f=await contextFixture();const {createChatQueue}=await import('../src/core/chat-queue/service.js');const q=createChatQueue({tracing:{messageRetentionDays:30},storage:f.storage,handler:async()=> 'completed'});
 try{await q.start();await q.admit(f.scope,queueMessage(f.scope.chatId,'m'),()=>true);await flushQueue();const t=await f.storage.traces.get(f.scope,1);expect(t?.payload.publication).toMatchObject({reaction:'silence',status:'suppressed',reason:'no_port'});expect(t?.payload.summary?.usage.input).toEqual({knownTokens:0,unknownAttempts:0,overflowed:false});}finally{await q.stop();await f.storage.close();}
});
