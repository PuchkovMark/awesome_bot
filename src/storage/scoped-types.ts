import type { QuestionnaireReply, QuestionnaireReplyResult } from './questionnaire-types';
import type { PassportReply, PassportReplyResult } from './chat-passport-types';
import type { ProfileCommandEdit, ProfileCommandEditResult } from './profile-command-types';
import type { VersionStore } from './version-types';
import type { ConnectionScope, UserId } from '../contracts/index';
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
import type {
  OwnProfileFact,
  ProfileFactInput,
  ProfileFactWriteResult,
  ProfileReadReference,
  PublicInterestMatches,
  PublicProfile,
} from './participant-types';

export interface ScopedAuthorizationTransaction extends AuthorizationTransaction {
  applyQuestionnaireReply(
    actorId: UserId,
    input: QuestionnaireReply,
    now: number,
  ): QuestionnaireReplyResult;
  applyPassportReply(actorId: UserId, input: PassportReply, now: number): PassportReplyResult;
  editOwnProfile(actorId: UserId, input: ProfileCommandEdit, now: number): ProfileCommandEditResult;
  readOwnProfile(actorId: UserId, now: number): readonly OwnProfileFact[];
  changeProfileFact(actorId: UserId, input: ProfileFactInput): ProfileFactWriteResult;
}

export interface ProfileFactWriter {
  record(
    scope: ConnectionScope,
    actorId: UserId,
    sourceKind: 'self' | 'admin' | 'inferred',
    input: ProfileFactInput,
  ): ProfileFactWriteResult;
}

export interface ScopedStorage {
  readonly traces: import('./trace-types').TraceReader;
  readonly contextState: import('./context-types').ContextStateReader;
  readonly contextMessages: import('./context-types').ContextMessageReader &
    import('./context-reader').ContextSearch;
  /** Только сведения, разрешённые аудитории чата. Личная выгрузка относится к F5.8. */
  readonly profileFacts: {
    read(scope: ConnectionScope, subjectId: UserId): PublicProfile;
    searchInterests(scope: ConnectionScope, interest: string): PublicInterestMatches;
    isCurrent(scope: ConnectionScope, reference: ProfileReadReference): boolean;
  };
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
      callback: (tx: ScopedAuthorizationTransaction) => T,
    ): Promise<T>;
    pruneReasons(
      now: number,
      retentionMs: number,
    ): Promise<{ readonly cleared: number; readonly nextRevokedAt: number | null }>;
  };
}
