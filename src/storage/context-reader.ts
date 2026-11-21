import type {Connection} from './connection.js';
import type {LifecycleBackend} from './lifecycle-store.js';
import type {ContextMessageReader,ContextRecord} from './context-types.js';
import {readMessage,createMessageStore} from './messages.js';
import {requireInput} from './validation.js';
function positive(n:number,max=Number.MAX_SAFE_INTEGER){requireInput(Number.isSafeInteger(n)&&n>0&&n<=max);}
const projection=`id,chat_id AS chatId,platform_message_id AS messageId,user_id AS userId,role,
 CAST(substr(CAST(text AS BLOB),1,?) AS TEXT) AS text,CAST(substr(CAST(author_name AS BLOB),1,?) AS TEXT) AS authorName,
 length(CAST(text AS BLOB)) AS textBytes,length(CAST(author_name AS BLOB)) AS nameBytes,
 reply_to_message_id AS replyToMessageId,timestamp,purpose,attachment_count AS attachmentCount`;
type Row=Omit<ContextRecord,'truncated'|'replyToMessageId'>&{replyToMessageId:string|null;textBytes:number;nameBytes:number};
function result(row:Row,limit:number):ContextRecord {
 const {textBytes,nameBytes,replyToMessageId,...rest}=row;
 const text=Array.from(row.text),name=Array.from(row.authorName);
 return {...rest,text:text.slice(0,limit).join(''),authorName:name.slice(0,limit).join(''),...(replyToMessageId!==null?{replyToMessageId}:{}),truncated:text.length>limit||name.length>limit||textBytes>limit*4||nameBytes>limit*4};
}
export function createContextReader(connection:Connection,lifecycle:LifecycleBackend):ContextMessageReader {
 const reader=createMessageStore(connection,true);
 return Object.freeze({
  async get(scope,id){return lifecycle.transaction(scope,db=>readMessage(db,scope.chatId,id,true));},
  async list(scope,query){return lifecycle.transaction(scope,()=>reader.list(scope.chatId,query));},
  async page(scope,q){return lifecycle.transaction(scope,db=>{
   positive(q.cutoffId);positive(q.limit,256);positive(q.textLimit,16384);if(q.beforeId!==undefined)positive(q.beforeId);
   const rows=db.prepare(`SELECT ${projection} FROM messages WHERE chat_id=? AND purpose='conversation' AND id<=? AND id<? ORDER BY id DESC LIMIT ?`).all(q.textLimit*4,q.textLimit*4,scope.chatId,q.cutoffId,q.beforeId??Number.MAX_SAFE_INTEGER,q.limit) as Row[];
   return rows.map(r=>result(r,q.textLimit));
  });},
  async reply(scope,id,cutoff,limit){return lifecycle.transaction(scope,db=>{
   positive(cutoff);positive(limit,16384);requireInput(typeof id==='string'&&id.length>0);
   const row=db.prepare(`SELECT ${projection} FROM messages WHERE chat_id=? AND platform_message_id=? AND purpose='conversation' AND id<=?`).get(limit*4,limit*4,scope.chatId,id,cutoff) as Row|undefined;
   return row?result(row,limit):null;
  });},
 } satisfies ContextMessageReader);
}
