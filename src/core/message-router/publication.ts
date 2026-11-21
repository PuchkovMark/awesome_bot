import type {PublicationDecision} from './types.js';
import type {RouteMetadata} from '../../storage/queue-types.js';
import type {ResponseMode} from '../../storage/index.js';
export {noticeText,noticeTemplate} from '../../storage/notice-types.js';
export function publicationDecision(route:RouteMetadata|null,current:{readonly enabled:boolean;readonly responseMode:ResponseMode},outcome:unknown):PublicationDecision {
 const silence={kind:'silence'} as const;
 if(!route||!['direct_message','mention','reply','name'].includes(route.kind)||!['normal','active'].includes(route.mode)||typeof route.isGroupChat!=='boolean'||!current||current.enabled!==true||!['normal','active'].includes(current.responseMode)||!outcome||typeof outcome!=='object')return silence;
 const kind=Object.getOwnPropertyDescriptor(outcome,'kind')?.value as unknown;
 if(kind==='complete'){
  const text=Object.getOwnPropertyDescriptor(outcome,'text')?.value as unknown;
  return typeof text==='string'&&text.trim()?{kind:'answer',text}:silence;
 }
 if(route.mode==='active'||(route.isGroupChat&&current.responseMode==='active'))return silence;
 if(kind==='current_message_too_large')return {kind:'notice',template:'current_message_too_large'};
 return typeof kind==='string'&&['incomplete','refused','empty','rate_limit','tools_not_supported','deadline_exceeded','attempt_limit','error','failed','queue_full','missing_system_prompt','static_budget_too_small','internal_error'].includes(kind)?{kind:'notice'}:silence;
}
