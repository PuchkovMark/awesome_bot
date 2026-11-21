import type { VersionStore } from './version-types.js';
import type { ConnectionScope } from '../contracts/index.js';
import type { AppendResult, ChatInput, ChatPatch, ChatSettings, CreateChatResult, HistoryQuery, MessageInput, StoredMessage } from './types.js';
import type { AuthorizationTransaction } from './authorization-types.js';
export interface ScopedStorage {
  readonly versions:Pick<VersionStore,'append'|'get'|'systemPrompt'>;
  readonly messages: {
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
