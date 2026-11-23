import type { VersionStore } from './version-types';
import type { ConnectionScope } from '../contracts/index';
import type {
  AppendResult,
  ChatInput,
  ChatPatch,
  ChatSettings,
  CreateChatResult,
  HistoryQuery,
  MessageInput,
  StoredMessage,
} from './types';
import type { AuthorizationTransaction } from './authorization-types';
export interface ScopedStorage {
  readonly traces: import('./trace-types').TraceReader;
  readonly contextState: import('./context-types').ContextStateReader;
  readonly contextMessages: import('./context-types').ContextMessageReader &
    import('./context-reader').ContextSearch;
  readonly queue: import('./queue-types').QueueStore;
  readonly versions: VersionStore;
  readonly messages: {
    get(scope: ConnectionScope, id: number): Promise<StoredMessage | null>;
    append(scope: ConnectionScope, message: MessageInput): Promise<AppendResult>;
    list(scope: ConnectionScope, query: HistoryQuery): Promise<readonly StoredMessage[]>;
  };
  readonly chats: {
    get(scope: ConnectionScope): Promise<ChatSettings | null>;
    create(scope: ConnectionScope, input: ChatInput): Promise<CreateChatResult>;
    update(scope: ConnectionScope, patch: ChatPatch): Promise<ChatSettings | null>;
  };
  readonly authorization: {
    transaction<T>(
      scope: ConnectionScope,
      callback: (tx: AuthorizationTransaction) => T,
    ): Promise<T>;
    pruneReasons(
      now: number,
      retentionMs: number,
    ): Promise<{ readonly cleared: number; readonly nextRevokedAt: number | null }>;
  };
}
