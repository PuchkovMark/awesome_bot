import {historyBounds} from './history-retention-store';
import type {Connection} from './connection';
import type {LifecycleBackend} from './lifecycle-store';
import type {ContextMessageReader,ContextRecord} from './context-types';
import {readMessage,createMessageStore} from './messages';
import {requireInput} from './validation';
function positive(n:number,max=Number.MAX_SAFE_INTEGER){requireInput(Number.isSafeInteger(n)&&n>0&&n<=max);}
const projection=`id,chat_id AS chatId,platform_message_id AS messageId,user_id AS userId,role,
 coalesce(CAST(substr(CAST(text AS BLOB),1,?) AS TEXT),'') AS text,coalesce(CAST(substr(CAST(author_name AS BLOB),1,?) AS TEXT),'') AS authorName,
 length(CAST(text AS BLOB)) AS textBytes,length(CAST(author_name AS BLOB)) AS nameBytes,
 reply_to_message_id AS replyToMessageId,timestamp,purpose,attachment_count AS attachmentCount`;
type Row=Omit<ContextRecord,'truncated'|'replyToMessageId'>&{replyToMessageId:string|null;textBytes:number;nameBytes:number};
function result(row:Row,limit:number):ContextRecord {
 const {textBytes,nameBytes,replyToMessageId,...rest}=row;
 const text=Array.from(row.text),name=Array.from(row.authorName);
 return {...rest,text:text.slice(0,limit).join(''),authorName:name.slice(0,limit).join(''),...(replyToMessageId!==null?{replyToMessageId}:{}),truncated:text.length>limit||name.length>limit||textBytes>limit*4||nameBytes>limit*4};
}
export interface ContextSearch {
 search(scope:import('../contracts/index').ConnectionScope,query:string,limit:number,textLimit:number):Promise<readonly ContextRecord[]>;
}
export function createContextReader(connection:Connection,lifecycle:LifecycleBackend):ContextMessageReader & ContextSearch {
 const reader=createMessageStore(connection,true);
 return Object.freeze({
  async get(scope,id){return lifecycle.transaction(scope,db=>readMessage(db,scope.chatId,id,true));},
  async list(scope,query){return lifecycle.transaction(scope,()=>reader.list(scope.chatId,query));},
  async page(scope,q){return lifecycle.transaction(scope,db=>{
   positive(q.cutoffId);positive(q.limit,256);positive(q.textLimit,16384);if(q.beforeId!==undefined)positive(q.beforeId);
   const bounds=historyBounds(db,scope.chatId);
   const rows=db.prepare(`SELECT ${projection} FROM messages WHERE chat_id=? AND purpose='conversation' AND id>? AND timestamp>? AND id<=? AND id<? ORDER BY id DESC LIMIT ?`).all(q.textLimit*4,q.textLimit*4,scope.chatId,bounds.clearedThrough,bounds.expiredThrough,q.cutoffId,q.beforeId??Number.MAX_SAFE_INTEGER,q.limit) as Row[];
   return rows.map(r=>result(r,q.textLimit));
  });},
  async reply(scope,id,cutoff,limit){return lifecycle.transaction(scope,db=>{
   positive(cutoff);positive(limit,16384);requireInput(typeof id==='string'&&id.length>0);
   const bounds=historyBounds(db,scope.chatId);
   const row=db.prepare(`SELECT ${projection} FROM messages WHERE chat_id=? AND platform_message_id=? AND purpose='conversation' AND id>? AND timestamp>? AND id<=?`).get(limit*4,limit*4,scope.chatId,id,bounds.clearedThrough,bounds.expiredThrough,cutoff) as Row|undefined;
   return row?result(row,limit):null;
  });},
  async search(scope,query,limit,textLimit){return lifecycle.transaction(scope,db=>{
   positive(limit,100);positive(textLimit,16384);
   requireInput(typeof query==='string' && query.trim().length>0 && query.length<=512);
   const bounds=historyBounds(db,scope.chatId);
   const phrase='"'+query.replaceAll('"','""')+'"';
   const rows=db.prepare(`SELECT ${projection} FROM messages WHERE id IN (
     SELECT messages_fts.rowid FROM messages_fts JOIN messages m ON m.id=messages_fts.rowid
     WHERE messages_fts MATCH ? AND m.chat_id=? AND m.purpose='conversation' AND m.id>? AND m.timestamp>?
     ORDER BY messages_fts.rowid DESC LIMIT ?
   ) ORDER BY id DESC`).all(textLimit*4,textLimit*4,phrase,scope.chatId,bounds.clearedThrough,bounds.expiredThrough,limit) as Row[];
   return rows.map(row=>result(row,textLimit));
  });},
 } satisfies ContextMessageReader & ContextSearch);
}
