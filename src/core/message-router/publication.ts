import type {PublicationDecision} from './types';
import type {RouteMetadata} from '../../storage/queue-types';
import type {ResponseMode} from '../../storage/index';
export {noticeText,noticeTemplate} from '../../storage/notice-types';
export function publicationDecision(route:RouteMetadata|null,current:{readonly enabled:boolean;readonly responseMode:ResponseMode},outcome:unknown):PublicationDecision {
 const silence={kind:'silence'} as const;
 if(!route||!['direct_message','mention','reply','name'].includes(route.kind)||!['normal','active'].includes(route.mode)||typeof route.isGroupChat!=='boolean'||!current||current.enabled!==true||!['normal','active'].includes(current.responseMode)||!outcome||typeof outcome!=='object')return silence;
 const kind=Object.getOwnPropertyDescriptor(outcome,'kind')?.value as unknown;
 if(kind==='complete'){
  const text=Object.getOwnPropertyDescriptor(outcome,'text')?.value as unknown;
  return typeof text==='string'&&text.trim()?{kind:'answer',text}:silence;
 }
 if(kind==='mention_flood')return {kind:'notice',template:'mention_flood'};
 if(kind==='quota_exhausted')return {kind:'notice',template:'quota_exhausted'};
 if(route.mode==='active'||(route.isGroupChat&&current.responseMode==='active'))return silence;
 if(kind==='current_message_too_large')return {kind:'notice',template:'current_message_too_large'};
 return typeof kind==='string'&&['incomplete','refused','empty','rate_limit','tools_not_supported','deadline_exceeded','attempt_limit','error','failed','queue_full','missing_system_prompt','static_budget_too_small','internal_error','trace_write_failed'].includes(kind)?{kind:'notice'}:silence;
}

export function publicationRow(route:RouteMetadata|null,outcome:unknown):import('../../storage/trace-types').TracePublication['rowId'] {
 if(!route)return 'invalid_route';
 const kind=outcome&&typeof outcome==='object'?Object.getOwnPropertyDescriptor(outcome,'kind')?.value as unknown:undefined;
 if(typeof kind!=='string')return 'silent_outcome';
 if(['incomplete','refused','empty'].includes(kind))return 'unusable_response';
 if(['complete','queue_full','quota_exhausted','current_message_too_large','static_budget_too_small','trace_write_failed'].includes(kind))return kind;
 return ['incomplete','refused','empty','rate_limit','tools_not_supported','deadline_exceeded','attempt_limit','error','failed','missing_system_prompt','internal_error'].includes(kind)?'unsuccessful':'silent_outcome';
}
