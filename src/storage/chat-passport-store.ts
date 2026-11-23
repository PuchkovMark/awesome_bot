import type { PassportRevision } from '../contracts/chat-passport';
import type { ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import { createMessageStore } from './messages';
import {
  passportPromptLifetime,
  passportSectionBytes,
  passportSections,
  type PassportEntry,
  type PassportPromptAction,
  type PassportReply,
  type PassportReplyResult,
  type PassportSection,
} from './chat-passport-types';
import type { Storage } from './types';
import { compositeId, requireInput, timestamp } from './validation';

const sectionScope = 'chat_id=? AND generation=? AND section=?';
const receiptScope = 'chat_id=? AND generation=? AND receipt=?';
const revoke =
  'UPDATE chat_passport_prompts SET actor_id=NULL,action=NULL,revision=NULL,expires_at=NULL';

interface Prompt {
  readonly section: PassportSection;
  readonly actor: UserId | null;
  readonly action: PassportPromptAction | null;
  readonly revision: number | null;
  readonly expiresAt: number | null;
}

export function createChatPassportStore(connection: Connection, lifecycle: LifecycleBackend) {
  const messages = createMessageStore(connection);
  return {
    read(scope: ConnectionScope): readonly PassportEntry[] {
      return lifecycle.transaction(scope, (db) => {
        const entries = db
          .prepare(
            'SELECT section,text,revision FROM chat_passport_sections WHERE chat_id=? AND generation=?',
          )
          .all(scope.chatId, scope.generation) as PassportEntry[];
        return passportSections.map(
          (section) =>
            entries.find((entry) => entry.section === section) ?? {
              section,
              revision: 0,
              text: null,
            },
        );
      });
    },
    current(scope: ConnectionScope, revisions: readonly PassportRevision[]) {
      if (!revisions.length) return true;
      return lifecycle.transaction(scope, (db) => {
        const read = db
          .prepare(`SELECT revision FROM chat_passport_sections WHERE ${sectionScope}`)
          .pluck();
        return revisions.every(
          ({ section, revision }) =>
            (read.get(scope.chatId, scope.generation, section) ?? 0) === revision,
        );
      });
    },
    sectionForReply(scope: ConnectionScope, receipt: string): PassportSection | undefined {
      return lifecycle.transaction(
        scope,
        (db) =>
          db
            .prepare(`SELECT section FROM chat_passport_prompts WHERE ${receiptScope}`)
            .pluck()
            .get(scope.chatId, scope.generation, receipt) as PassportSection | undefined,
      );
    },
    recordPrompt(
      scope: ConnectionScope,
      actor: UserId,
      entry: PassportEntry,
      action: PassportPromptAction,
      part: PublishedPart,
      now: number,
    ) {
      compositeId(actor);
      timestamp(now);
      timestamp(now + passportPromptLifetime);
      requireInput(Number.isSafeInteger(entry.revision) && entry.revision >= 0);
      requireInput(/^[1-9][0-9]*$/u.test(part.messageId) && part.replyToMessageId === undefined);
      return lifecycle.transaction(scope, (db) => {
        const recorded = messages.append({
          chatId: scope.chatId,
          messageId: part.messageId,
          userId: part.userId,
          authorName: part.authorName,
          role: 'assistant',
          text: part.text,
          timestamp: part.timestamp,
        });
        if (recorded.status !== 'inserted') return false;
        db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(recorded.id);
        db.prepare(
          `INSERT INTO chat_passport_prompts
          (chat_id,generation,receipt,message_id,section,actor_id,action,revision,expires_at)
          VALUES(?,?,?,?,?,?,?,?,?)`,
        ).run(
          scope.chatId,
          scope.generation,
          part.messageId,
          recorded.id,
          entry.section,
          actor,
          action,
          entry.revision,
          now + passportPromptLifetime,
        );
        return true;
      });
    },
    apply(
      scope: ConnectionScope,
      actor: UserId,
      input: PassportReply,
      now: number,
    ): PassportReplyResult {
      timestamp(now);
      return lifecycle.transaction(scope, (db) => {
        const key = [scope.chatId, scope.generation, input.receipt];
        const prompt = db
          .prepare(
            `SELECT section,actor_id AS actor,action,revision,expires_at AS expiresAt
          FROM chat_passport_prompts WHERE ${receiptScope}`,
          )
          .get(...key) as Prompt | undefined;
        if (
          !prompt ||
          prompt.actor !== actor ||
          prompt.expiresAt === null ||
          now >= prompt.expiresAt
        )
          return 'closed';
        const deactivate = () => db.prepare(`${revoke} WHERE ${receiptScope}`).run(...key);
        const section = [scope.chatId, scope.generation, prompt.section];
        const revision =
          (db
            .prepare(`SELECT revision FROM chat_passport_sections WHERE ${sectionScope}`)
            .pluck()
            .get(...section) as number | undefined) ?? 0;
        if (revision !== prompt.revision) {
          deactivate();
          return 'stale';
        }
        const confirmation = input.text.trim().toLowerCase() === 'подтверждаю';
        if (confirmation !== (prompt.action === 'clear')) return 'invalid_confirmation';
        const value = prompt.action === 'clear' ? null : input.text;
        if (value !== null) {
          if (!value.trim()) return 'empty';
          if (Buffer.byteLength(value) > passportSectionBytes) return 'too_long';
        }
        db.prepare(
          `INSERT INTO chat_passport_sections (chat_id,generation,section,text,revision) VALUES(?,?,?,?,?)
          ON CONFLICT(chat_id,generation,section) DO UPDATE SET text=excluded.text,revision=excluded.revision`,
        ).run(...section, value, revision + 1);
        deactivate();
        return 'applied';
      });
    },
    prune(now: number) {
      timestamp(now);
      connection.run((db) => db.prepare(`${revoke} WHERE expires_at<=?`).run(now));
    },
  };
}

const stores = new WeakMap<Storage, ReturnType<typeof createChatPassportStore>>();
export function registerChatPassport(
  storage: Storage,
  store: ReturnType<typeof createChatPassportStore>,
) {
  stores.set(storage, store);
}
export function chatPassportStore(storage: Storage) {
  const store = stores.get(storage);
  requireInput(store);
  return store;
}
