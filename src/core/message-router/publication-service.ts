import type {ConnectionScope} from '../../contracts/index.js';
import type {Storage} from '../../storage/index.js';
import type {RouteMetadata} from '../../storage/queue-types.js';
import type {QueueCompletion,QueueSettlement} from '../chat-queue/types.js';
import type {NoticeReceipt,NoticePermit} from '../../storage/notice-types.js';
import type {TracePublication} from '../../storage/trace-types.js';
import {traceBackend} from '../../storage/trace-store.js';
import {noticeBackend} from '../../storage/notice-store.js';
import {noticeInterval} from './notice-config.js';
import {publicationDecision,publicationRow,noticeTemplate} from './publication.js';
export interface PublicationRequest {readonly scope:ConnectionScope;readonly kind:'answer'|'notice';readonly text:string;readonly replyToMessageId?:string;readonly signal:AbortSignal}
export type PublicationResult={readonly kind:'delivered';readonly receipt:NoticeReceipt}|{readonly kind:'failed'|'unknown'};
export interface PublicationPort {
 canReply(scope:ConnectionScope,signal:AbortSignal):Promise<boolean>;
 publish(input:PublicationRequest):Promise<PublicationResult>;
}
async function bounded<T>(signal:AbortSignal,promise:Promise<T>):Promise<T|null>{
 if(signal.aborted){void promise.catch(()=>{});return null;}
 let abort:()=>void=()=>{};
 const interrupted=new Promise<null>(resolve=>{abort=()=>resolve(null);signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([promise,interrupted]);}finally{signal.removeEventListener('abort',abort);}
}
export function createPublicationService(options:{readonly storage:Storage;readonly port?:PublicationPort;readonly noticeIntervalMs?:number;readonly queueFullTimeoutMs?:number;readonly onFailure?:(code:'publication_failed'|'journal_failed'|'trace_write_failed')=>void}){
 const fullTimeout=noticeInterval(options.queueFullTimeoutMs??10000);if(fullTimeout>2147483647)throw new TypeError('Router: invalid_configuration');
 const interval=noticeInterval(options.noticeIntervalMs),notices=noticeBackend(options.storage),traces=traceBackend(options.storage);
 const counters={publication_failed:0,journal_failed:0,trace_write_failed:0};
 const report=(code:keyof typeof counters)=>{counters[code]=Math.min(Number.MAX_SAFE_INTEGER,counters[code]+1);try{options.onFailure?.(code);}catch{/* Диагностика не меняет исход. */}};
 const active=new Set<number>();
 async function publish(work:QueueSettlement,outcome:unknown,queueFull=false):Promise<string>{
  const jobId=work.jobId;
  if(!queueFull&&(jobId===undefined||active.has(jobId)))return 'silence';
  if(jobId!==undefined)active.add(jobId);
  let permit:NoticePermit|undefined,traceFailed=false;
  const rowId=publicationRow(work.route,outcome);
  const save=(pub:TracePublication):boolean=>{
   if(queueFull)return true;
   if(jobId===undefined)return false;
   try{if(traces.publication(work.scope,jobId,pub))return true;}catch{/* Попытка минимальной формы ниже. */}
   traces.report('full_write_failed');
   try{if(traces.publication(work.scope,jobId,pub,true)){traces.report('minimal_saved');return true;}}catch{/* Текст ошибки не читается. */}
   if(!traceFailed){traceFailed=true;traces.report('trace_write_failed');report('trace_write_failed');}return false;
  };
  const suppressed=(reason:TracePublication['reason'])=>{save({rowId,tableVersion:1,reaction:'silence',status:'suppressed',reason});return 'silence';};
  try{
   if(!queueFull){const row=traces.get(work.scope,jobId);if(!row||row.finishedAt===null||row.payload.publication.status!=='pending_checks')return 'silence';}
   if(!work.route||work.signal.aborted||!work.isCurrent())return suppressed('guard');
   if(!options.port)return suppressed('no_port');
   const settings=await options.storage.chats.get(work.scope);if(!settings||!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   let decision=publicationDecision(work.route,settings,outcome);if(decision.kind==='silence')return suppressed('none');
   const source=await options.storage.messages.get(work.scope,work.messageId);if(!source||!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   const reply=await bounded(work.signal,options.port.canReply(work.scope,work.signal));
   if(!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   const current=await options.storage.chats.get(work.scope);if(!current||publicationDecision(work.route,current,outcome).kind!==decision.kind||!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   // Проверка после await защищает и от второго экземпляра сервиса в одном процессе.
   if(!queueFull&&traces.get(work.scope,jobId)?.payload.publication.status!=='pending_checks')return 'silence';
   if(decision.kind==='notice'){
    if(reply!==true)return suppressed('no_reply');
    permit=notices.reserve(work.scope,work.messageId,work.route,interval,Date.now(),decision.template??'generic')??undefined;if(!permit)return suppressed('notice_period');
   }
   const saved=save({rowId,tableVersion:1,reaction:decision.kind,status:'allowed',reason:'none'});
   if(!saved){
    decision=publicationDecision(work.route,current,{kind:'trace_write_failed'});
    if(decision.kind!=='notice'||reply!==true)return 'silence';
    if(permit)notices.retarget(permit);
    else permit=notices.reserve(work.scope,work.messageId,work.route,interval,Date.now(),'generic')??undefined;
    if(!permit)return 'silence';
   }
   if(!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   const latest=await options.storage.chats.get(work.scope);
   if(!latest||publicationDecision(work.route,latest,traceFailed?{kind:'trace_write_failed'}:outcome).kind!==decision.kind||!work.isCurrent()||work.signal.aborted)return suppressed('guard');
   const text=decision.kind==='notice'?noticeTemplate(traceFailed?'generic':decision.template??'generic'):decision.text;
   const result=await bounded(work.signal,options.port.publish({scope:work.scope,kind:decision.kind,text,...(reply===true?{replyToMessageId:source.messageId}:{}),signal:work.signal}));
   if(!result||result.kind!=='delivered'){
    report('publication_failed');if(!traceFailed)save({rowId,tableVersion:1,reaction:decision.kind,status:result?.kind==='failed'?'failed':'unknown',reason:'publication_failed'});return result?.kind??'unknown';
   }
   if(!work.isCurrent()||work.signal.aborted){report('journal_failed');return 'unknown';}
   try{
    if(permit)notices.confirm(work.scope,permit,result.receipt);
    else notices.recordAnswer(work.scope,result.receipt,text,reply===true?source.messageId:undefined);
   }catch{report('journal_failed');if(!traceFailed)save({rowId,tableVersion:1,reaction:decision.kind,status:'unknown',reason:'journal_failed'});return 'journal_failed';}
   if(!traceFailed)save({rowId,tableVersion:1,reaction:decision.kind,status:'delivered',reason:'none'});
   return 'delivered';
  }catch{report('publication_failed');return 'failed';}finally{if(permit)notices.discard(permit);if(jobId!==undefined)active.delete(jobId);}
 }
 return Object.freeze({
  stats(){return Object.freeze({...counters});},
  async onSettled(work:QueueSettlement,completion:QueueCompletion){await publish(work,completion.preparationFailure?{kind:completion.preparationFailure}:completion.result??{kind:completion.outcome});},
  async queueFull(scope:ConnectionScope,messageId:number,route:RouteMetadata,guard:{readonly signal:AbortSignal;readonly isCurrent:()=>boolean}){
   const signal=AbortSignal.any([guard.signal,AbortSignal.timeout(fullTimeout)]);
   await publish({scope,messageId,route,signal,isCurrent:()=>!signal.aborted&&guard.isCurrent()},{kind:'queue_full'},true);
  },
 });
}
