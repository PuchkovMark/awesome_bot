import type { VersionStore } from './version-types.js';
import type { ConnectionScope } from '../contracts/index.js';
import type { AppendResult, ChatInput, ChatPatch, ChatSettings, CreateChatResult, HistoryQuery, MessageInput, StoredMessage } from './types.js';
import type { AuthorizationTransaction } from './authorization-types.js';
export interface ScopedStorage {
  readonly contextState: import('./context-types.js').ContextStateReader;
  readonly contextMessages: import('./context-types.js').ContextMessageReader;
  readonly queue: import('./queue-types.js').QueueStore;
  readonly versions:VersionStore;
  readonly messages: {
    get(scope:ConnectionScope,id:number):Promise<StoredMessage|null>;
    append(scope:ConnectionScope,message:MessageInput):Promise<AppendResult>;
    list(scope:ConnectionScope,query:HistoryQuery):Promise<readonly StoredMessage[]>;
  };
  readonly chats: {
    get(scope:ConnectionScope):Promise<ChatSettings|null>;
    create(scope:ConnectionScope,input:ChatInput):Promise<CreateChatResult>;
    update(scope:ConnectionScope,patch:ChatPatch):Promise<ChatSettings|null>;
  };
  readonly authorization: {
    transaction<T>(scope:ConnectionScope,callback:(tx:AuthorizationTransaction)=>T):Promise<T>;
    pruneReasons(now:number,retentionMs:number):Promise<{readonly cleared:number;readonly nextRevokedAt:number|null}>;
  };
}
