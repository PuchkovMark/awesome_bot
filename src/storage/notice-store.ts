import type {Connection} from './connection.js';
import type {LifecycleBackend} from './lifecycle-store.js';
import type {ConnectionScope} from '../contracts/index.js';
import type {NoticeBackend,NoticePermit} from './notice-types.js';
import {noticeText} from './notice-types.js';
import {readMessage,createMessageStore} from './messages.js';
import {requireInput,timestamp,string} from './validation.js';
export function createNoticeBackend(connection:Connection,lifecycle:LifecycleBackend):NoticeBackend {
 const permits=new WeakMap<object,{scope:ConnectionScope;source:string;confirmed:string|null}>();
 const messages=createMessageStore(connection);
 return {
  reserve(scope,messageId,route,interval,now){
   timestamp(now);requireInput(Number.isSafeInteger(interval)&&interval>0);timestamp(now+interval);
   return lifecycle.transaction(scope,db=>{
    const settings=db.prepare('SELECT enabled,response_mode AS mode FROM chats WHERE chat_id=?').get(scope.chatId) as {enabled:number;mode:string}|undefined;
    if(!settings?.enabled||settings.mode==='silent'||route.mode!=='normal'||(route.isGroupChat&&settings.mode==='active'))return null;
    const source=readMessage(db,scope.chatId,messageId);if(!source||source.purpose!=='conversation')return null;
    const changed=db.prepare(`INSERT INTO notice_periods(chat_id,generation,next_at) VALUES(?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET next_at=excluded.next_at WHERE notice_periods.generation=excluded.generation AND notice_periods.next_at<=?`).run(scope.chatId,scope.generation,now+interval,now).changes;
    if(!changed)return null;
    const permit=Object.freeze({}) as NoticePermit;permits.set(permit,{scope,source:source.messageId,confirmed:null});return permit;
   });
  },
  confirm(scope,permit,receipt){
   lifecycle.transaction(scope,db=>{
    const data=permits.get(permit);requireInput(data?.scope===scope);
    string(receipt.messageId,true);string(receipt.authorName);timestamp(receipt.timestamp);
    requireInput(data.confirmed===null||data.confirmed===receipt.messageId);
    const input={chatId:scope.chatId,messageId:receipt.messageId,userId:receipt.userId,authorName:receipt.authorName,role:'assistant' as const,text:noticeText,replyToMessageId:data.source,timestamp:receipt.timestamp};
    const appended=messages.append(input);
    if(appended.status==='inserted')db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(appended.id);
    else{const old=readMessage(db,scope.chatId,appended.id);requireInput(old?.purpose==='service_notice'&&old.text===noticeText&&old.replyToMessageId===data.source&&old.role==='assistant'&&old.userId===receipt.userId);}
    data.confirmed=receipt.messageId;
   });
  },
  discard(permit){permits.delete(permit);},
 };
}
const backends=new WeakMap<object,NoticeBackend>();
export function registerNotices(storage:object,backend:NoticeBackend){backends.set(storage,backend);}
export function noticeBackend(storage:object):NoticeBackend {const found=backends.get(storage);requireInput(found);return found;}
