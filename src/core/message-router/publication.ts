import type {PublicationDecision} from './types.js';
import type {RouteMetadata} from '../../storage/queue-types.js';
import type {ResponseMode} from '../../storage/index.js';
export const noticeText='Сейчас не получилось ответить. Попробуйте позже.';
export function publicationDecision(route:RouteMetadata|null,current:{readonly enabled:boolean;readonly responseMode:ResponseMode},outcome:unknown):PublicationDecision {
 const silence={kind:'silence'} as const;
 if(!route||!current.enabled||current.responseMode==='silent'||!outcome||typeof outcome!=='object')return silence;
 const kind=Object.getOwnPropertyDescriptor(outcome,'kind')?.value as unknown;
 if(kind==='complete'){
  const text=Object.getOwnPropertyDescriptor(outcome,'text')?.value as unknown;
  return typeof text==='string'&&text.trim()?{kind:'answer',text}:silence;
 }
 if(route.mode==='active'||(route.isGroupChat&&current.responseMode==='active'))return silence;
 return typeof kind==='string'&&['incomplete','refused','empty','rate_limit','tools_not_supported','deadline_exceeded','attempt_limit','error','failed','queue_full'].includes(kind)?{kind:'notice'}:silence;
}
