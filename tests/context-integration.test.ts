import {expect,test,vi} from 'vitest';
import {contextFixture,contextCapabilities} from './helpers/context.js';
import {createContextPreparation} from '../src/core/prepare-context.js';
import {createAgentLoopQueue} from '../src/core/chat-queue/agent-loop-adapter.js';
import {createMessageRouter} from '../src/core/message-router/service.js';
import {flushQueue} from './helpers/chat-queue.js';
import type {LlmRequest} from '../src/llm/types.js';
import {safeEvent} from '../src/logger/sanitize.js';
test('роутер → очередь → сборщик → цикл: поздний ответ исключён, server повторяет один снимок',async()=>{
 vi.useFakeTimers();const f=await contextFixture();const stats:object[]=[];const captured:LlmRequest[]=[];
 const prep=createContextPreparation({...f.options,storage:f.storage,onStats:s=>stats.push(s)});
 const selected=await f.admin.systemPrompt();expect(prep.checkStartup(selected)).toBeNull();
 const q=createAgentLoopQueue({storage:f.storage,prepare:prep.prepare,client:{async complete(input){captured.push(input);if(captured.length===1)return{kind:'error',code:'server',message:'SECRET'};return{kind:'complete',text:'Ответ',usage:{input:0,output:0}};}}});
 try{
 await q.start();const router=createMessageRouter({storage:f.storage,queue:q});
 await router.receive(f.scope,{kind:'message',chatId:f.scope.chatId,messageId:'trigger',userId:'vk:u',authorName:'Имя',text:'Пенек помоги',isBot:false,isAdmin:false,isGroupChat:true,isMentioned:false,isReplyToBot:false,timestamp:10,attachments:[]});
 await f.put('late','Человек ответил',{timestamp:0});await flushQueue();await flushQueue();
 expect(captured).toHaveLength(1);expect(JSON.stringify(captured[0])).not.toContain('Человек ответил');
 const old=await f.admin.systemPrompt();const v=await f.admin.append({kind:'system_prompt',key:'base',text:'НОВЫЕ ПРАВИЛА',createdAt:1,expectedHead:1});if(v.status!=='created'||v.value.ref.area!=='global')throw Error();await f.admin.selectSystemPrompt(v.value.ref,old!.ref as never);
 await vi.advanceTimersByTimeAsync(1000);expect(captured).toHaveLength(2);expect(captured[0]!.system).toBe(captured[1]!.system);expect(captured[0]!.messages).toEqual(captured[1]!.messages);expect(stats.length).toBeGreaterThan(0);
 }finally{await q.stop();await f.storage.close();vi.useRealTimers();}
});
test('счётчик начальной ошибки и белый список логов не копируют секреты',async()=>{
 const f=await contextFixture();try{
 const prep=createContextPreparation({...f.options,storage:f.storage,capabilities:async()=>contextCapabilities(f.scope.chatId)});
 expect(prep.checkStartup(null)).toBe('missing_system_prompt');const counts=prep.stats();expect(counts.missing_system_prompt).toBe(1);
 expect(safeEvent({event:'context_stats',window:'run',...counts,secret:'PRIVATE',chatId:'vk:a'})).toEqual({event:'context_stats',window:'run',...counts});
 expect(safeEvent({event:'context_stats',window:'run',...counts,internal_error:-1})).toBeUndefined();
 }finally{await f.storage.close();}
});
