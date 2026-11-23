import {expect,test} from 'vitest';
import {contextFixture} from './helpers/context';
import {createContextBuilder} from '../src/core/context/index';
import {estimateInput} from '../src/core/context/budget';
test('история заканчивается исходной записью, reply вне окна не дублируется',async()=>{
 const f=await contextFixture();try{
 const parent=await f.put('parent','цитируемое');await f.put('history','обычная история');const current=await f.put('trigger','вопрос',{replyToMessageId:'parent'});await f.put('late','человек уже ответил',{timestamp:0});
 const r=await f.builder.prepare(f.work(current.id));expect(r.kind).toBe('ready');if(r.kind!=='ready')return;
 expect(r.metadata.messageIds).toEqual([parent.id+1,parent.id,current.id]);expect(r.metadata.reply).toBe('included');
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
 expect(r.metadata.reply).toBe('truncated');expect(r.metadata.estimatedTokens).toBeLessThanOrEqual(8000);
 expect(JSON.parse(r.input.messages[0]!.text)).toMatchObject({kind:'untrusted_chat_data',current:{text:'важный вопрос'},reply:{truncated:true}});
 }finally{await f.storage.close();}
});
test.each([true, false])('полное текущее сообщение на границе бюджета, беседа=%s', async group => {
 const f = await contextFixture();
 try {
  const text = '"😀\n'.repeat(150);
  const current = await f.put('trigger', text);
  const work = f.work(current.id, group);
  const initial = await f.builder.prepare(work);
  if (initial.kind !== 'ready') throw Error(initial.kind);
  const estimated = estimateInput(initial.input.system, initial.input.messages);
  const exact = estimated + f.builder.config.environmentReserveTokens - initial.metadata.layerBytes.environment;
  const prepareWithBudget = (inputBudgetTokens: number) => createContextBuilder({
   ...f.options, config: {...f.options.config, inputBudgetTokens},
  }).prepare(work);

  const result = await prepareWithBudget(exact);
  if (result.kind !== 'ready') throw Error(result.kind);
  expect(JSON.parse(result.input.messages[0]!.text)).toMatchObject({kind:'untrusted_chat_data',current:{text}});
  expect(result.metadata.estimatedTokens).toBe(estimated);
  expect(await prepareWithBudget(exact - 1)).toEqual({kind:'failed',reason:'current_message_too_large'});
 } finally { await f.storage.close(); }
});
test('неактуальность после чтения и зависшая зависимость не вызывают ready',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','вопрос');const controller=new AbortController();controller.abort();expect(await f.builder.prepare({...f.work(a.id),signal:controller.signal})).toEqual({kind:'cancelled'});
 const b=createContextBuilder({...f.options,config:{modelContextTokens:16000,preparationTimeoutMs:10},capabilities:()=>new Promise(()=>{})});expect(await b.prepare(f.work(a.id))).toEqual({kind:'deadline_exceeded'});
 const foreign=createContextBuilder({...f.options,capabilities:async()=>({...await f.options.capabilities(),context:{chatId:'vk:other'}})});expect(await foreign.prepare(f.work(a.id))).toEqual({kind:'failed',reason:'internal_error'});
 }finally{await f.storage.close();}
});
test('лимит одной цитаты отмечает недоступное окно истории как сокращённое',async()=>{
 const f=await contextFixture();try{
 await f.put('old','более ранняя история');await f.put('parent','цитата');const a=await f.put('a','вопрос',{replyToMessageId:'parent'});
 const builder=createContextBuilder({...f.options,config:{modelContextTokens:16000,maxHistoryMessages:1}});const r=await builder.prepare(f.work(a.id));if(r.kind!=='ready')throw Error();expect(r.metadata.historyTruncated).toBe(true);
 }finally{await f.storage.close();}
});
test('утрата актуальности и поддельная область не дают готового контекста',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','вопрос');let valid=true;
 const b=createContextBuilder({...f.options,capabilities:async()=>{valid=false;return f.options.capabilities();}});
 expect(await b.prepare({...f.work(a.id),isCurrent:()=>valid})).toEqual({kind:'cancelled'});
 expect((await f.builder.prepare({...f.work(a.id),scope:{...f.scope} as never})).kind).not.toBe('ready');
 }finally{await f.storage.close();}
});
test('смена общей версии после её чтения сохраняет согласованный старый снимок',async()=>{
 const f=await contextFixture();try{
 const a=await f.put('a','вопрос');const next=await f.admin.append({kind:'system_prompt',key:'base',text:'Другая версия',createdAt:1,expectedHead:1});if(next.status!=='created'||next.value.ref.area!=='global')throw Error();
 const b=createContextBuilder({...f.options,capabilities:async()=>{await f.admin.selectSystemPrompt(next.value.ref as never,f.version.ref as never);return f.options.capabilities();}});
 const result=await b.prepare(f.work(a.id));if(result.kind!=='ready')throw Error(result.kind);expect(result.metadata.version).toEqual(f.version.ref);expect(result.input.system.startsWith(f.version.text)).toBe(true);expect(result.input.system).not.toContain('Другая версия');
 }finally{await f.storage.close();}
});
