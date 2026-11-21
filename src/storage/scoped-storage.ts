import type { Connection } from './connection.js';
import type { LifecycleBackend } from './lifecycle-store.js';
import type { ScopedStorage } from './scoped-types.js';
import { createMessageStore } from './messages.js';
import { createChatStore } from './chats.js';
import { createAuthorizationStore } from './authorization-store.js';
import { requireInput } from './validation.js';
export function createScopedStorage(connection:Connection,backend:LifecycleBackend):ScopedStorage {
  const messages=createMessageStore(connection),chats=createChatStore(connection),authorization=createAuthorizationStore(connection);
  return {
    messages:{
      async append(scope,message) {return backend.transaction(scope,()=>{requireInput(message.chatId===scope.chatId);return messages.append(message);});},
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
