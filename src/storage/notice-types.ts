import type {ConnectionScope,UserId} from '../contracts/index.js';
import type {RouteMetadata} from './queue-types.js';
export const noticeText='Сейчас не получилось ответить. Попробуйте позже.';
export type NoticeKind='generic'|'current_message_too_large';
export function noticeTemplate(kind:NoticeKind):string {return kind==='current_message_too_large'?'Сообщение слишком большое для ответа. Попробуйте сократить его.':noticeText;}
declare const permitBrand:unique symbol;
export interface NoticePermit {readonly [permitBrand]:true}
export interface NoticeReceipt {readonly messageId:string;readonly userId:UserId;readonly authorName:string;readonly timestamp:number}
export interface NoticeBackend {
 reserve(scope:ConnectionScope,messageId:number,route:RouteMetadata,interval:number,now:number,kind?:NoticeKind):NoticePermit|null;
 confirm(scope:ConnectionScope,permit:NoticePermit,receipt:NoticeReceipt,text?:string):void;
 recordAnswer(scope:ConnectionScope,receipt:NoticeReceipt,text:string,replyToMessageId?:string):void;
 retarget(permit:NoticePermit):void;
 discard(permit:NoticePermit):void;
}
