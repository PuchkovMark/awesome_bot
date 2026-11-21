import type {ConnectionScope} from '../../contracts/index.js';
import type {Storage} from '../../storage/index.js';
import type {RouteMetadata} from '../../storage/queue-types.js';
import type {QueueCompletion,QueueSettlement} from '../chat-queue/types.js';
import type {NoticeReceipt} from '../../storage/notice-types.js';
import {noticeBackend} from '../../storage/notice-store.js';
import {noticeInterval} from './notice-config.js';
import {publicationDecision,noticeText} from './publication.js';
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
export function createPublicationService(options:{readonly storage:Storage;readonly port?:PublicationPort;readonly noticeIntervalMs?:number;readonly queueFullTimeoutMs?:number;readonly onFailure?:(code:'publication_failed'|'journal_failed')=>void}){
 const fullTimeout=noticeInterval(options.queueFullTimeoutMs??10000);if(fullTimeout>2147483647)throw new TypeError('Router: invalid_configuration');
 const interval=noticeInterval(options.noticeIntervalMs),notices=noticeBackend(options.storage);
 const counters={publication_failed:0,journal_failed:0};
 const report=(code:'publication_failed'|'journal_failed')=>{counters[code]=Math.min(Number.MAX_SAFE_INTEGER,counters[code]+1);try{options.onFailure?.(code);}catch{/* Безопасная диагностика не меняет исход. */}};
 async function publish(work:QueueSettlement,outcome:unknown):Promise<string>{
  if(!options.port||!work.route||work.signal.aborted||!work.isCurrent())return 'silence';
  let permit:import('../../storage/notice-types.js').NoticePermit|undefined;
  try{
   const settings=await options.storage.chats.get(work.scope);if(!settings||!work.isCurrent()||work.signal.aborted)return 'silence';
   const decision=publicationDecision(work.route,settings,outcome);if(decision.kind==='silence')return 'silence';
   const source=await options.storage.messages.get(work.scope,work.messageId);if(!source||!work.isCurrent()||work.signal.aborted)return 'silence';
   const reply=await bounded(work.signal,options.port.canReply(work.scope,work.signal));
   if(!work.isCurrent()||work.signal.aborted)return 'silence';
   const current=await options.storage.chats.get(work.scope);if(!current||publicationDecision(work.route,current,outcome).kind!==decision.kind||!work.isCurrent()||work.signal.aborted)return 'silence';
   if(decision.kind==='notice'){
    if(reply!==true)return 'silence';
    permit=notices.reserve(work.scope,work.messageId,work.route,interval,Date.now())??undefined;if(!permit)return 'silence';
   }
   if(!work.isCurrent()||work.signal.aborted)return 'silence';
   const text=decision.kind==='notice'?noticeText:decision.text;
   const result=await bounded(work.signal,options.port.publish({scope:work.scope,kind:decision.kind,text,...(reply===true?{replyToMessageId:source.messageId}:{}),signal:work.signal}));
   if(!result||result.kind!=='delivered'){report('publication_failed');return result?.kind??'unknown';}
   if(!work.isCurrent()||work.signal.aborted){report('journal_failed');return 'unknown';}
   try{
    if(permit)notices.confirm(work.scope,permit,result.receipt);
    else notices.recordAnswer(work.scope,result.receipt,text,reply===true?source.messageId:undefined);
   }catch{report('journal_failed');return 'journal_failed';}
   return 'delivered';
  }catch{report('publication_failed');return 'failed';}finally{if(permit)notices.discard(permit);}
 }
 return Object.freeze({
  stats(){return Object.freeze({...counters});},
  async onSettled(work:QueueSettlement,completion:QueueCompletion){await publish(work,completion.result??{kind:completion.outcome});},
  async queueFull(scope:ConnectionScope,messageId:number,route:RouteMetadata,guard:{readonly signal:AbortSignal;readonly isCurrent:()=>boolean}){
   const signal=AbortSignal.any([guard.signal,AbortSignal.timeout(fullTimeout)]);
   await publish({scope,messageId,route,signal,isCurrent:()=>!signal.aborted&&guard.isCurrent()},{kind:'queue_full'});
  },
 });
}
