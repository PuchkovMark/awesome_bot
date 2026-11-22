import { createRouterMetrics } from './metrics.js';
import type {SafeLogger} from '../../logger/types.js';
import type {ConnectionScope,IncomingMessage,AuthorizationContext} from '../../contracts/index.js';
import type {Storage} from '../../storage/index.js';
import type {ChatQueue} from '../chat-queue/types.js';
import type {RoutingDecision,ServiceCommand} from './types.js';
import {routeMessage} from './routing.js';
import {validIncoming} from './validation.js';
import {commandAccess,type RouterAuthorization} from './command-boundary.js';
import type {RoutedQueueDecision,RouteMetadata} from '../../storage/queue-types.js';
function fromDecision(value:RoutedQueueDecision):RoutingDecision {
 if(value.route)return {kind:'ordinary',reason:value.route.kind,route:value.route};
 if(value.reason==='service')return {kind:'service',reason:'service'};
 return {kind:'silence',reason:value.reason as Extract<RoutingDecision,{kind:'silence'}>['reason']};
}
export interface RouterOptions {
 readonly logger?:SafeLogger;readonly storage:Storage;readonly queue:ChatQueue;readonly authorization?:RouterAuthorization;
 readonly recognizeCommand?:(message:IncomingMessage)=>ServiceCommand|null;
 readonly onDecision?:(decision:RoutingDecision)=>void;
 readonly onQueueFull?:(scope:ConnectionScope,messageId:number,route:RouteMetadata,guard:{readonly signal:AbortSignal;readonly isCurrent:()=>boolean})=>Promise<void>;
}
export function createMessageRouter(options:RouterOptions){
 const metrics=createRouterMetrics(options.logger);
 return Object.freeze({stats:metrics.snapshot,async receive(scope:ConnectionScope,input:IncomingMessage,context?:AuthorizationContext,isCurrent?:()=>boolean){
  const message=Object.freeze({...input});
  if(isCurrent && !isCurrent())return {decision:null,admission:null};
  if(!validIncoming(message)||message.chatId!==scope.chatId)return {decision:{kind:'silence',reason:'invalid_input'} as RoutingDecision,admission:null};
  const settings=(await options.storage.chats.create(scope,{responseMode:'normal',enabled:true,createdAt:message.timestamp})).settings;
  if(isCurrent && !isCurrent())return {decision:null,admission:null};
  const command=options.recognizeCommand?.(message)??null;
  const service=command?await commandAccess(options.authorization,context,scope,message,command):undefined;
  if(isCurrent && !isCurrent())return {decision:null,admission:null};
  if(!settings.enabled){
   const decision=routeMessage({message,settings,...(service?{service}:{})});return {decision,admission:null};
  }
  const record={chatId:message.chatId,messageId:message.messageId,userId:message.userId,authorName:message.authorName,role:'user' as const,attachmentCount:message.attachments.length,text:message.text,timestamp:message.timestamp,...(message.replyToMessageId?{replyToMessageId:message.replyToMessageId}:{})};
  const result=await options.queue.admitRouted(scope,record,snapshot=>{
   const decision=routeMessage({message,settings:snapshot.settings,...(service?{service}:{})});
   return {reason:decision.reason,route:decision.kind==='ordinary'?decision.route:null};
  });
  const decision=result.decision?fromDecision(result.decision):null;
  if(decision){metrics?.record(decision);try{options.onDecision?.(decision);}catch{/* Диагностика не меняет решение. */}}
  if(result.admission.status==='queue_full'&&decision?.kind==='ordinary')await options.onQueueFull?.(scope,result.admission.messageId,decision.route,{signal:options.queue.signal,isCurrent:options.queue.isRunning});
  return {decision,admission:result.admission};
 }});
}
