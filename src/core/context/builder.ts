import {setImmediate as yieldImmediate} from 'node:timers/promises';
import type {ConnectionScope} from '../../contracts/lifecycle';
import type {CapabilitySnapshot} from '../../contracts/capabilities';
import type {ContextMessageReader,ContextStateReader} from '../../storage/context-types';
import {contextConfig,type ContextConfig} from './config';
import {contextSeparator,estimateInput} from './budget';
import {validateContextStartup} from './startup';
import {formatEnvironment,type ContextRoute} from './environment';
import {formatMessages,type ContextEntry} from './format';
import type {PreparationResult} from './types';
import {createContextMetrics} from './metrics';
export interface ContextWork {readonly scope:ConnectionScope;readonly messageId:number;readonly route:ContextRoute|null;readonly signal:AbortSignal;readonly isCurrent:()=>boolean}
export interface ContextBuilderOptions {
 readonly messages:ContextMessageReader;readonly state:ContextStateReader;
 readonly config:Pick<ContextConfig,'modelContextTokens'>&Partial<ContextConfig>;
 readonly capabilities:(scope:ConnectionScope)=>Promise<CapabilitySnapshot>;
 readonly onStats?:(stats:ReturnType<ReturnType<typeof createContextMetrics>['snapshot']>)=>void;
 readonly sessionId:(scope:ConnectionScope)=>string;readonly now?:()=>number;
}
export function createContextBuilder(options:ContextBuilderOptions){
 const c=contextConfig(options.config),metrics=createContextMetrics();
 const emit=()=>{try{options.onStats?.(metrics.snapshot());}catch{/* Диагностика не меняет подготовку. */}};
 async function build(w:ContextWork,signal:AbortSignal):Promise<PreparationResult>{
  const valid=()=>!signal.aborted&&w.isCurrent();
  if(!valid())return {kind:'cancelled'};
  if(!w.route)return {kind:'unavailable'};
  const current=await options.messages.get(w.scope,w.messageId);if(!valid())return {kind:'cancelled'};
  if(!current||current.role!=='user')return {kind:'unavailable'};
  const settings=await options.state.settings(w.scope);if(!valid())return {kind:'cancelled'};
  if(!settings?.enabled||settings.responseMode==='silent')return {kind:'cancelled'};
  const version=await options.state.systemPrompt(w.scope);if(!valid())return {kind:'cancelled'};
  const failure=validateContextStartup(version,c);if(failure)return {kind:'failed',reason:failure};
  if(!version||version.ref.area!=='global'||version.ref.kind!=='system_prompt')return {kind:'failed',reason:'internal_error'};
  const caps=await options.capabilities(w.scope);if(!valid())return {kind:'cancelled'};
  if(caps.context.chatId!==w.scope.chatId||(caps.context.userId!==undefined&&caps.context.userId!==current.userId))return {kind:'failed',reason:'internal_error'};
  const env=formatEnvironment({now:options.now?.()??Date.now(),timezone:settings.timezone,platform:w.scope.chatId.split(':')[0]!,capabilities:caps,route:w.route});
  if(Buffer.byteLength(env)>c.environmentReserveTokens)return {kind:'failed',reason:'internal_error'};
  const system=version.text+contextSeparator+env;
  let reply:ContextEntry|null=null;
  let replyState:'none'|'included'|'truncated'|'unavailable'=current.replyToMessageId?'unavailable':'none';
  const history:ContextEntry[]=[];
  const serialize=()=>formatMessages(history,current,reply,replyState,w.route!.isGroupChat,settings.timezone);
  // Неиспользованный резерв окружения остаётся резервом, а не историей.
  const cost=()=>estimateInput(system,serialize())+c.environmentReserveTokens-Buffer.byteLength(env);
  if(cost()>c.inputBudgetTokens)return {kind:'failed',reason:'current_message_too_large'};
  let replyId:number|undefined;
  if(current.replyToMessageId){
   const source=await options.messages.reply(w.scope,current.replyToMessageId,current.id,c.replyTextCodePoints);if(!valid())return {kind:'cancelled'};
   if(source&&source.id!==current.id){
    replyId=source.id;reply={message:source,truncated:source.truncated};replyState=source.truncated?'truncated':'included';
    // Двоичный поиск выдержки: работа ограничена, текущий текст не обрезается.
    if(cost()>c.inputBudgetTokens){
     const points=Array.from(source.text);let low=0,high=points.length;
     while(low<high){const mid=Math.ceil((low+high)/2);reply={message:{...source,text:points.slice(0,mid).join('')},truncated:true};replyState='truncated';if(cost()<=c.inputBudgetTokens)low=mid;else high=mid-1;}
     reply=low?{message:{...source,text:points.slice(0,low).join('')},truncated:true}:null;replyState=low?'truncated':'unavailable';
    }
   }
  }
  let before=current.id,scanned=0,truncated=!!reply&&c.maxHistoryMessages===1,done=false;
  while(!done&&scanned<c.maxScannedMessages&&history.length+(reply?1:0)<c.maxHistoryMessages){
   const limit=Math.min(c.historyPageSize,c.maxScannedMessages-scanned);
   const page=await options.messages.page(w.scope,{cutoffId:current.id,beforeId:before,limit,textLimit:c.historyTextCodePoints});if(!valid())return {kind:'cancelled'};
   if(!page.length)break;
   for(const message of page){
    scanned++;before=message.id;
    if(message.id===replyId)continue;
    const entry:ContextEntry={message,truncated:message.truncated};history.unshift(entry);
    if(cost()>c.inputBudgetTokens){history.shift();truncated=true;done=true;break;}
    if(message.truncated)truncated=true;
    if(history.length+(reply?1:0)>=c.maxHistoryMessages){truncated=true;done=true;break;}
   }
   if(page.length<limit)break;
   await yieldImmediate();if(!valid())return {kind:'cancelled'};
  }
  if(scanned>=c.maxScannedMessages)truncated=true;
  const latest=await options.state.settings(w.scope);if(!valid()||!latest?.enabled||latest.responseMode==='silent')return {kind:'cancelled'};
  const messages=Object.freeze(serialize().map(m=>Object.freeze({...m})));
  const estimatedTokens=estimateInput(system,messages);
  if(estimatedTokens>c.inputBudgetTokens)return {kind:'failed',reason:'internal_error'};
  const metadata=Object.freeze({version:Object.freeze({...version.ref}),cutoffId:current.id,messageIds:Object.freeze([...history.map(e=>e.message.id),...(reply?[reply.message.id]:[]),current.id]),layerBytes:Object.freeze({system:Buffer.byteLength(version.text),environment:Buffer.byteLength(env),messages:messages.reduce((n,m)=>n+Buffer.byteLength(m.text),0)}),estimatedTokens,scanned,historyTruncated:truncated,reply:replyState,absentLayers:Object.freeze(['persona','passport','profiles','memory','summaries'])});
  return {kind:'ready',input:Object.freeze({system,messages,maxOutputTokens:c.maxOutputTokens,sessionId:options.sessionId(w.scope)}),metadata};
 }
 return Object.freeze({config:c,stats:metrics.snapshot,checkStartup(version:Parameters<typeof validateContextStartup>[0]){const failure=validateContextStartup(version,c);if(failure)metrics.record(failure);emit();return failure;},async prepare(work:ContextWork):Promise<PreparationResult>{
  const timer=new AbortController();const signal=AbortSignal.any([work.signal,timer.signal]);let abort:()=>void=()=>{};
  const interrupted=new Promise<PreparationResult>(resolve=>{abort=()=>resolve({kind:work.signal.aborted?'cancelled':'deadline_exceeded'});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  const timeout=setTimeout(()=>timer.abort(),c.preparationTimeoutMs);
  try{
   const result=await Promise.race([build(work,signal).catch(():PreparationResult=>signal.aborted?{kind:work.signal.aborted?'cancelled':'deadline_exceeded'}:{kind:'failed',reason:'internal_error'}),interrupted]);metrics.record(result);emit();return result;
  }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
 }});
}
