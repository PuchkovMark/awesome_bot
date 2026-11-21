import {expect,test} from 'vitest';
import {contextFixture} from './helpers/context.js';
import {createContextBuilder} from '../src/core/context/index.js';
test('история заканчивается исходной записью, reply вне окна не дублируется',async()=>{
 const f=await contextFixture();try{
 const parent=await f.put('parent','цитируемое');await f.put('history','обычная история');const current=await f.put('trigger','вопрос',{replyToMessageId:'parent'});await f.put('late','человек уже ответил',{timestamp:0});
 const r=await f.builder.prepare(f.work(current.id));expect(r.kind).toBe('ready');if(r.kind!=='ready')return;
 expect(r.metadata.messageIds).toEqual([parent.id+1,parent.id,current.id]);expect(r.metadata.reply).toBe('included');expect(r.input.system).not.toContain('LEGACY_SECRET');
 expect(r.input.system).toContain('могли прийти новые сообщения');expect(JSON.stringify(r.input)).not.toContain('человек уже ответил');
 const data=JSON.parse(r.input.messages[0]!.text);expect(data.reply.text).toBe('цитируемое');expect(data.history).toHaveLength(1);expect(data.current.text).toBe('вопрос');
 expect(Object.isFrozen(r.metadata.messageIds)).toBe(true);
 }finally{await f.storage.close();}
});
test('пустая история, DM и одиночное вложение; статичный префикс не зависит от даты',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','',{attachmentCount:1});const r=await f.builder.prepare(f.work(a.id,false));expect(r.kind).toBe('ready');if(r.kind!=='ready')return;
 expect(r.input.messages[0]?.text).toContain('Вложение: содержимое недоступно');expect(r.metadata.messageIds).toEqual([a.id]);
 const later=createContextBuilder({...f.options,now:()=>86400000});const s=await later.prepare(f.work(a.id,false));if(s.kind!=='ready')throw Error();expect(s.input.system.startsWith(f.version.text)).toBe(true);expect(s.input.system).not.toBe(r.input.system);
 }finally{await f.storage.close();}
});
test('классификация переполнения, отсутствие версии и безопасные счётчики',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','x'.repeat(15000));expect(await f.builder.prepare(f.work(a.id))).toEqual({kind:'failed',reason:'current_message_too_large'});expect(f.builder.stats().current_message_too_large).toBe(1);
 const small=createContextBuilder({...f.options,config:{modelContextTokens:16000,inputBudgetTokens:1050}});expect(await small.prepare(f.work(a.id))).toEqual({kind:'failed',reason:'static_budget_too_small'});
 await f.admin.resetSystemPrompt(f.version.ref as never);expect(await f.builder.prepare(f.work(a.id))).toEqual({kind:'failed',reason:'missing_system_prompt'});
 }finally{await f.storage.close();}
});
test('большая цитата помечается и не вытесняет текущее сообщение',async()=>{
 const f=await contextFixture();try{
 await f.put('p','😀'.repeat(10000));const a=await f.put('a','важный вопрос',{replyToMessageId:'p'});const r=await f.builder.prepare(f.work(a.id));if(r.kind!=='ready')throw Error(r.kind);
 expect(r.metadata.reply).toBe('truncated');expect(r.metadata.estimatedTokens).toBeLessThanOrEqual(8000);expect(r.input.messages[0]!.text).toContain('важный вопрос');expect(r.input.messages[0]!.text).toContain('"truncated":true');
 }finally{await f.storage.close();}
});
test('неактуальность после чтения и зависшая зависимость не вызывают ready',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','вопрос');const controller=new AbortController();controller.abort();expect(await f.builder.prepare({...f.work(a.id),signal:controller.signal})).toEqual({kind:'cancelled'});
 const b=createContextBuilder({...f.options,config:{modelContextTokens:16000,preparationTimeoutMs:10},capabilities:()=>new Promise(()=>{})});expect(await b.prepare(f.work(a.id))).toEqual({kind:'deadline_exceeded'});
 const foreign=createContextBuilder({...f.options,capabilities:async()=>({...await f.options.capabilities(),context:{chatId:'vk:other'}})});expect(await foreign.prepare(f.work(a.id))).toEqual({kind:'failed',reason:'internal_error'});
 }finally{await f.storage.close();}
});
