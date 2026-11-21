import type {Connection} from './connection.js';
import type {LifecycleBackend} from './lifecycle-store.js';
import type {VersionBackend} from './version-store.js';
import type {ContextStateReader} from './context-types.js';
export function createContextStateReader(connection:Connection,lifecycle:LifecycleBackend,versions:VersionBackend):ContextStateReader {
 return Object.freeze({
  async settings(scope){return lifecycle.transaction(scope,db=>{
   const row=db.prepare('SELECT enabled,response_mode AS responseMode,timezone FROM chats WHERE chat_id=?').get(scope.chatId) as {enabled:number;responseMode:'silent'|'normal'|'active';timezone:string}|undefined;
   return row?Object.freeze({...row,enabled:row.enabled===1}):null;
  });},
  async systemPrompt(scope){return versions.systemPrompt(scope);},
 } satisfies ContextStateReader);
}
