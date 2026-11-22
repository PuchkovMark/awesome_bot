import type {ConnectionScope,UserId} from '../contracts/index.js';
import type {RouteMetadata} from './queue-types.js';
export const noticeText='Сейчас не получилось ответить. Попробуйте позже.';
const templates = {
  generic: noticeText,
  current_message_too_large: 'Сообщение слишком большое для ответа. Попробуйте сократить его.',
  quota_exhausted: 'Сейчас слишком много запросов. Попробуй чуть позже.',
};
export type NoticeKind = keyof typeof templates;
export function noticeTemplate(kind: NoticeKind): string { return templates[kind]; }
declare const permitBrand:unique symbol;
export interface NoticePermit {readonly [permitBrand]:true}
export interface NoticeReceipt {readonly messageId:string;readonly userId:UserId;readonly authorName:string;readonly timestamp:number}
export interface NoticeBackend {
 readonly sourceVisible:(scope:ConnectionScope,id:number)=>boolean;
 reserve(scope:ConnectionScope,messageId:number,route:RouteMetadata,interval:number,now:number,kind?:NoticeKind):NoticePermit|null;
 confirm(scope:ConnectionScope,permit:NoticePermit,receipt:NoticeReceipt,text?:string,isCurrent?:()=>boolean):void;
 recordAnswer(scope:ConnectionScope,receipt:NoticeReceipt,text:string,replyToMessageId?:string,isCurrent?:()=>boolean):void;
 retarget(permit:NoticePermit):void;
 discard(permit:NoticePermit):void;
}
