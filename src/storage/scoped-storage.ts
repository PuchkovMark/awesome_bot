import type { QuestionnaireReply, QuestionnaireReplyResult } from './questionnaire-types';
import type { PassportReply, PassportReplyResult } from './chat-passport-types';
import type { ProfileCommandEdit, ProfileCommandEditResult } from './profile-command-types';
import { selectOwnProfile } from './profile-fact-selection';
import { createProfileFactReader } from './profile-fact-reader';
import { createContextStateReader } from './context-state-reader';
import { createContextReader } from './context-reader';
import type { ConnectionScope, UserId } from '../contracts/index';
import type { QueueRecord } from './queue-types';
import type { VersionBackend } from './version-store';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type {
  ProfileFactWriter,
  ScopedAuthorizationTransaction,
  ScopedStorage,
} from './scoped-types';
import { readMessage, createMessageStore } from './messages';
import { createChatStore } from './chats';
import { createAuthorizationStore } from './authorization-store';
import { requireInput } from './validation';
export function createScopedStorage(
  connection: Connection,
  backend: LifecycleBackend,
  versions: VersionBackend,
  queue: { get(scope: ConnectionScope, id: number): QueueRecord | null },
  facts: ProfileFactWriter,
  editProfile: (
    scope: ConnectionScope,
    actor: UserId,
    input: ProfileCommandEdit,
    now: number,
  ) => ProfileCommandEditResult,
  applyPassport: (
    scope: ConnectionScope,
    actor: UserId,
    input: PassportReply,
    now: number,
  ) => PassportReplyResult,
  replaceQuestionnaire: (
    scope: ConnectionScope,
    actor: UserId,
    input: QuestionnaireReply,
    now: number,
  ) => QuestionnaireReplyResult,
): Omit<ScopedStorage, 'traces'> {
  const messages = createMessageStore(connection),
    chats = createChatStore(connection),
    authorization = createAuthorizationStore(connection);
  return {
    contextState: createContextStateReader(connection, backend, versions),
    contextMessages: createContextReader(connection, backend),
    profileFacts: createProfileFactReader(backend),
    queue: {
      async get(scope, id) {
        return queue.get(scope, id);
      },
    },
    versions: {
      async selected(scope, kind) {
        return versions.selected(scope, kind);
      },
      async select(scope, kind, ref, expected) {
        return versions.select(scope, kind, ref, expected);
      },
      async reset(scope, kind, expected) {
        return versions.select(scope, kind, null, expected);
      },
      async append(scope, input) {
        return versions.appendLocal(scope, input);
      },
      async get(scope, ref) {
        return versions.get(scope, ref);
      },
      async systemPrompt(scope) {
        return versions.systemPrompt(scope);
      },
    },
    messages: {
      async get(scope, id) {
        return backend.transaction(scope, (db) => readMessage(db, scope.chatId, id));
      },
      async append(scope, message) {
        return backend.transaction(scope, () => {
          const snapshot = { ...message };
          requireInput(snapshot.chatId === scope.chatId);
          return messages.append(snapshot);
        });
      },
      async list(scope, query) {
        return backend.transaction(scope, () => messages.list(scope.chatId, query));
      },
    },
    chats: {
      async get(scope) {
        return backend.transaction(scope, () => chats.get(scope.chatId));
      },
      async create(scope, input) {
        return backend.transaction(scope, () => chats.create(scope.chatId, input));
      },
      async update(scope, patch) {
        return backend.transaction(scope, () => chats.update(scope.chatId, patch));
      },
    },
    authorization: {
      async transaction(scope, callback) {
        return backend.transaction(scope, (db) =>
          authorization.transaction(scope.chatId, (tx) =>
            callback(
              Object.freeze<ScopedAuthorizationTransaction>({
                ...tx,
                applyQuestionnaireReply(actorId, input, now) {
                  tx.revision();
                  if (!tx.claimControlMessage(actorId, input.eventId))
                    return { status: 'duplicate' };
                  return replaceQuestionnaire(scope, actorId, input, now);
                },
                applyPassportReply(actorId, input, now) {
                  tx.revision();
                  if (!tx.claimControlMessage(actorId, input.eventId)) return 'duplicate';
                  return applyPassport(scope, actorId, input, now);
                },
                editOwnProfile(actorId, input, now) {
                  tx.revision();
                  return editProfile(scope, actorId, input, now);
                },
                readOwnProfile(actorId, now) {
                  tx.revision();
                  return selectOwnProfile(db, scope, actorId, now);
                },
                changeProfileFact(actorId, input) {
                  tx.revision();
                  return facts.record(
                    scope,
                    actorId,
                    actorId === input.subjectId ? 'self' : 'admin',
                    input,
                  );
                },
              }),
            ),
          ),
        );
      },
      async pruneReasons(now, retentionMs) {
        return authorization.pruneReasons(now, retentionMs);
      },
    },
  };
}
