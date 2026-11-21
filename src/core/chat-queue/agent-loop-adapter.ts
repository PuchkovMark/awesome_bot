import type {LlmClient} from '../../llm/types.js';
import type {AgentLoopInput,AgentLoopOptions} from '../agent-loop/types.js';
import {createAgentLoop} from '../agent-loop/service.js';
import {loopOptions} from '../agent-loop/validation.js';
import {createChatQueue} from './service.js';
import {queueConfig} from './validation.js';
import {QueueError} from './errors.js';
import type {ChatQueueOptions,QueueHandlerInput,QueueConfig,QueueCompletion} from './types.js';
import type {PreparationResult} from '../context/types.js';
export type QueuePreparation={readonly kind:'ready';readonly input:Omit<AgentLoopInput,'signal'>}|Exclude<PreparationResult,{kind:'ready'}>;
export interface AgentLoopQueueOptions extends Omit<ChatQueueOptions,'handler'|'config'> {
 readonly client:LlmClient;readonly loopOptions?:AgentLoopOptions;
 readonly config?:Omit<Partial<QueueConfig>,'loopTimeoutMs'>;
 readonly preparationTimeoutMs?:number;readonly postPreparationMarginMs?:number;
 readonly prepare:(work:QueueHandlerInput)=>Promise<QueuePreparation>;
}
export function createAgentLoopQueue(options:AgentLoopQueueOptions){
 const settings=loopOptions(options.loopOptions??{}),loop=createAgentLoop(options.client,settings);
 const prep=options.preparationTimeoutMs??2000,margin=options.postPreparationMarginMs??1000;
 const config=queueConfig({...options.config,loopTimeoutMs:settings.timeoutMs});
 if(!Number.isSafeInteger(prep)||prep<=0||prep>2147483647||!Number.isSafeInteger(margin)||margin<=0||config.handlerTimeoutMs<settings.timeoutMs+prep+margin)throw new QueueError('invalid_input');
 return createChatQueue({storage:options.storage,...(options.logger?{logger:options.logger}:{}),...(options.onSettled?{onSettled:options.onSettled}:{}),config,
 handler:async work=>{
  const controller=new AbortController(),signal=AbortSignal.any([work.signal,controller.signal]);
  let abort:()=>void=()=>{};
  const interrupted=new Promise<QueuePreparation>(resolve=>{abort=()=>resolve({kind:work.signal.aborted?'cancelled':'deadline_exceeded'});signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  const timer=setTimeout(()=>controller.abort(),prep);
  let prepared:QueuePreparation;
  try{prepared=await Promise.race([Promise.resolve().then(()=>options.prepare({...work,signal})),interrupted]);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  if(work.signal.aborted||!work.isCurrent())return 'interrupted';
  if(prepared.kind==='cancelled')return 'interrupted';
  if(prepared.kind==='deadline_exceeded')return 'deadline_exceeded';
  if(prepared.kind==='unavailable')return 'message_missing';
  if(prepared.kind==='failed'){
   const allowed=['missing_system_prompt','static_budget_too_small','current_message_too_large','internal_error'];
   return {outcome:'failed',...(allowed.includes(prepared.reason)?{preparationFailure:prepared.reason}:{})} satisfies QueueCompletion;
  }
  if(prepared.kind!=='ready')return 'failed';
  // Финальная синхронная проверка выполняется непосредственно перед запуском цикла.
  if(!work.isCurrent()||work.signal.aborted)return 'interrupted';
  const result=await loop.run({...prepared.input,signal:work.signal});
  const outcome=result.kind==='complete'?'completed':result.kind==='rate_limit'?'rate_limit':result.kind==='deadline_exceeded'?'deadline_exceeded':result.kind==='cancelled'?'interrupted':'failed';
  return {outcome,result};
 }});
}
