import { createContextStateReader } from './context-state-reader.js';
import { createContextReader } from './context-reader.js';
import type { ConnectionScope } from '../contracts/index.js';
import type { QueueRecord } from './queue-types.js';
import type { VersionBackend } from './version-store.js';
import type { Connection } from './connection.js';
import type { LifecycleBackend } from './lifecycle-store.js';
import type { ScopedStorage } from './scoped-types.js';
import { readMessage, createMessageStore } from './messages.js';
import { createChatStore } from './chats.js';
import { createAuthorizationStore } from './authorization-store.js';
import { requireInput } from './validation.js';
export function createScopedStorage(connection:Connection,backend:LifecycleBackend,versions:VersionBackend,queue:{get(scope:ConnectionScope,id:number):QueueRecord|null}):Omit<ScopedStorage,'traces'> {
  const messages=createMessageStore(connection),chats=createChatStore(connection),authorization=createAuthorizationStore(connection);
  return {
    contextState:createContextStateReader(connection,backend,versions),
    contextMessages:createContextReader(connection,backend),
    queue:{async get(scope,id){return queue.get(scope,id);}},
    versions:{
      async selected(scope,kind){return versions.selected(scope,kind);},
      async select(scope,kind,ref,expected){return versions.select(scope,kind,ref,expected);},
      async reset(scope,kind,expected){return versions.select(scope,kind,null,expected);},
      async append(scope,input){return versions.appendLocal(scope,input);},async get(scope,ref){return versions.get(scope,ref);},async systemPrompt(scope){return versions.systemPrompt(scope);}},
    messages:{
      async get(scope,id){return backend.transaction(scope,db=>readMessage(db,scope.chatId,id));},
      async append(scope,message) {return backend.transaction(scope,()=>{const snapshot={...message};requireInput(snapshot.chatId===scope.chatId);return messages.append(snapshot);});},
      async list(scope,query) {return backend.transaction(scope,()=>messages.list(scope.chatId,query));},
    },
    chats:{
      async get(scope) {return backend.transaction(scope,()=>chats.get(scope.chatId));},
      async create(scope,input) {return backend.transaction(scope,()=>chats.create(scope.chatId,input));},
      async update(scope,patch) {return backend.transaction(scope,()=>chats.update(scope.chatId,patch));},
    },
    authorization:{
      async transaction(scope,callback) {return backend.transaction(scope,()=>authorization.transaction(scope.chatId,callback));},
      async pruneReasons(now,retentionMs) {return authorization.pruneReasons(now,retentionMs);},
    },
  };
}
