import type {Connection} from './connection.js';
import type {LifecycleBackend} from './lifecycle-store.js';
import type {ContextMessageReader} from './context-types.js';
import {readMessage,createMessageStore} from './messages.js';
/** Фабрика только для сборки Storage; контекст получает интерфейс, не фабрику. */
export function createContextReader(connection:Connection,lifecycle:LifecycleBackend):ContextMessageReader {
 const reader=createMessageStore(connection,true);
 return Object.freeze({
  async get(scope,id){return lifecycle.transaction(scope,db=>readMessage(db,scope.chatId,id,true));},
  async list(scope,query){return lifecycle.transaction(scope,()=>reader.list(scope.chatId,query));},
 } satisfies ContextMessageReader);
}
