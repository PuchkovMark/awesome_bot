import {expect,test,vi} from 'vitest';
import Database from 'better-sqlite3';
import {storageFixture} from './helpers/storage-fixture.js';
import {legacyChatPromptFixture,legacyPrompt,sharedPrompt} from './helpers/legacy-chat-prompt-fixture.js';
import {openStorage} from '../src/storage/index.js';
import {scopeFor} from './helpers/connection-scope.js';
import {createContextPreparation} from '../src/core/prepare-context.js';
import {createAgentLoopQueue} from '../src/core/chat-queue/agent-loop-adapter.js';
import {contextCapabilities} from './helpers/context.js';
import {flushQueue} from './helpers/chat-queue.js';
import {lifecycleBackend} from '../src/storage/lifecycle-store.js';
import type {LlmRequest} from '../src/llm/types.js';
for(const selected of [true,false])test(`восстановленное задание после upgrade: общий выбор ${selected}`,async()=>{
 vi.useFakeTimers();const f=storageFixture();let s:Awaited<ReturnType<typeof openStorage>>|undefined;
 let q:ReturnType<typeof createAgentLoopQueue>|undefined;
 try{
 const db=new Database(f.path);try{legacyChatPromptFixture(db,selected);expect(db.prepare("SELECT system_prompt FROM chats WHERE chat_id='vk:old'").get()).toEqual({system_prompt:legacyPrompt});}finally{db.close();}
 s=await openStorage(f.path);const scope=scopeFor(s,'vk:old'),other=scopeFor(s,'vk:other');
 const prep=createContextPreparation({storage:s,config:{modelContextTokens:16000},sessionId:()=> 'synthetic-session',capabilities:async()=>contextCapabilities(scope.chatId)});
 const calls:LlmRequest[]=[];
 q=createAgentLoopQueue({storage:s,prepare:prep.prepare,client:{async complete(input){calls.push(input);return{kind:'complete',text:'Ответ',usage:{input:0,output:0}};}}});
 expect(await s.versions.selected(scope,'persona')).toMatchObject({text:'локальный персонаж'});
 expect(await s.versions.selected(scope,'greeting_template')).toMatchObject({text:'приветствие'});
 const savedOther=await s.chats.get(other);expect(savedOther).not.toHaveProperty('systemPrompt');
 await q.start();await flushQueue();await flushQueue();
 expect(calls).toHaveLength(selected?1:0);
 if(selected){expect(calls[0]!.system.startsWith(sharedPrompt)).toBe(true);expect(JSON.stringify(calls)).not.toContain(legacyPrompt);expect(await s.queue.get(scope,1)).toMatchObject({state:'terminal',outcome:'completed'});}
 else{expect(prep.stats().missing_system_prompt).toBe(1);expect(await s.queue.get(scope,1)).toMatchObject({state:'terminal',outcome:'failed'});expect(await s.contextState.systemPrompt(scope)).toBeNull();}
 expect(await s.queue.get(scope,2)).toMatchObject({state:'terminal',outcome:'interrupted'});
 await q.stop();
 const before=await s.contextState.systemPrompt(scope);const life=lifecycleBackend(s);life.ownerDecision(life.begin(scope.chatId),'new');const renewed=scopeFor(s,scope.chatId);
 expect(renewed.generation).not.toBe(scope.generation);expect(await s.versions.selected(renewed,'persona')).toBeNull();expect(await s.versions.selected(renewed,'greeting_template')).toBeNull();expect(await s.messages.list(renewed,{limit:10})).toEqual([]);
 expect(await s.contextState.systemPrompt(renewed)).toEqual(before);expect(await s.chats.get(other)).toEqual(savedOther);
 }finally{if(q)await q.stop();if(s)await s.close();f.cleanup();vi.useRealTimers();}
});
