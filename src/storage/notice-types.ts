import type {ConnectionScope,UserId} from '../contracts/index.js';
import type {RouteMetadata} from './queue-types.js';
export const noticeText='Сейчас не получилось ответить. Попробуйте позже.';
declare const permitBrand:unique symbol;
export interface NoticePermit {readonly [permitBrand]:true}
export interface NoticeReceipt {readonly messageId:string;readonly userId:UserId;readonly authorName:string;readonly timestamp:number}
export interface NoticeBackend {
 reserve(scope:ConnectionScope,messageId:number,route:RouteMetadata,interval:number,now:number):NoticePermit|null;
 confirm(scope:ConnectionScope,permit:NoticePermit,receipt:NoticeReceipt):void;
 recordAnswer(scope:ConnectionScope,receipt:NoticeReceipt,text:string,replyToMessageId?:string):void;
 discard(permit:NoticePermit):void;
}
