import { historySourcesVisible } from './history-retention-store';
import type { Connection } from './connection';
import type { LifecycleBackend } from './lifecycle-store';
import type { ConnectionScope } from '../contracts/index';
import type { NoticeBackend, NoticePermit } from './notice-types';
import { isLlmAvailabilityNotice, isRateLimitedNotice, noticeTemplate } from './notice-types';
import { readMessage, createMessageStore } from './messages';
import { requireInput, timestamp, string } from './validation';
export function createNoticeBackend(
  connection: Connection,
  lifecycle: LifecycleBackend,
): NoticeBackend {
  const permits = new WeakMap<
    object,
    { scope: ConnectionScope; source: string; confirmed: string | null; text: string }
  >();
  const messages = createMessageStore(connection);
  return {
    sourceVisible(scope, id) {
      return lifecycle.transaction(scope, (db) => historySourcesVisible(db, scope.chatId, [id]));
    },
    reserve(scope, messageId, route, interval, now, kind = 'generic', queueFull) {
      requireInput(
        kind === 'generic' ||
          kind === 'current_message_too_large' ||
          isRateLimitedNotice(kind) ||
          isLlmAvailabilityNotice(kind),
      );
      timestamp(now);
      requireInput(Number.isSafeInteger(interval) && interval > 0);
      timestamp(now + interval);
      return lifecycle.transaction(scope, (db) => {
        const settings = db
          .prepare('SELECT enabled,response_mode AS mode FROM chats WHERE chat_id=?')
          .get(scope.chatId) as { enabled: number; mode: string } | undefined;
        if (
          !settings?.enabled ||
          settings.mode === 'silent' ||
          !['normal', 'active'].includes(route.mode)
        )
          return null;
        if (
          !isRateLimitedNotice(kind) &&
          (route.mode !== 'normal' || (route.isGroupChat && settings.mode === 'active'))
        )
          return null;
        const source = readMessage(db, scope.chatId, messageId);
        if (!source) return null;
        if (
          source.purpose !== 'conversation' &&
          !(queueFull && source.role === 'user' && source.purpose === 'service_notice') &&
          (!isLlmAvailabilityNotice(kind) ||
            !db
              .prepare(
                'SELECT 1 FROM questionnaire_inputs WHERE chat_id=? AND generation=? AND message_id=?',
              )
              .get(scope.chatId, scope.generation, messageId))
        )
          return null;
        const changed = db
          .prepare(
            `INSERT INTO notice_periods(chat_id,generation,next_at) VALUES(?,?,?)
      ON CONFLICT(chat_id) DO UPDATE SET next_at=excluded.next_at WHERE notice_periods.generation=excluded.generation AND notice_periods.next_at<=?`,
          )
          .run(scope.chatId, scope.generation, now + interval, now).changes;
        if (!changed) return null;
        const permit = Object.freeze({}) as NoticePermit;
        permits.set(permit, {
          scope,
          source: source.messageId,
          confirmed: null,
          text: noticeTemplate(kind),
        });
        return permit;
      });
    },
    confirm(scope, permit, receipt, text, isCurrent) {
      lifecycle.transaction(scope, (db) => {
        requireInput(isCurrent?.() !== false);
        const data = permits.get(permit);
        requireInput(data?.scope === scope);
        requireInput(
          (
            db.prepare('SELECT enabled FROM chats WHERE chat_id=?').get(scope.chatId) as
              { enabled: number } | undefined
          )?.enabled === 1,
        );
        string(receipt.messageId, true);
        string(receipt.authorName);
        timestamp(receipt.timestamp);
        requireInput(data.confirmed === null || data.confirmed === receipt.messageId);
        const deliveredText = text ?? data.text;
        const input = {
          chatId: scope.chatId,
          messageId: receipt.messageId,
          userId: receipt.userId,
          authorName: receipt.authorName,
          role: 'assistant' as const,
          text: deliveredText,
          replyToMessageId: data.source,
          timestamp: receipt.timestamp,
        };
        const appended = messages.append(input);
        if (appended.status === 'inserted')
          db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(appended.id);
        else {
          const old = readMessage(db, scope.chatId, appended.id);
          requireInput(
            old?.purpose === 'service_notice' &&
              old.text === deliveredText &&
              old.replyToMessageId === data.source &&
              old.role === 'assistant' &&
              old.userId === receipt.userId,
          );
        }
        data.confirmed = receipt.messageId;
      });
    },
    recordAnswer(scope, receipt, text, replyToMessageId, isCurrent) {
      lifecycle.transaction(scope, (db) => {
        requireInput(isCurrent?.() !== false);
        requireInput(
          (
            db.prepare('SELECT enabled FROM chats WHERE chat_id=?').get(scope.chatId) as
              { enabled: number } | undefined
          )?.enabled === 1,
        );
        const appended = messages.append({
          chatId: scope.chatId,
          ...receipt,
          role: 'assistant',
          text,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        });
        if (appended.status === 'duplicate') {
          const old = readMessage(db, scope.chatId, appended.id);
          requireInput(
            old?.purpose === 'conversation' &&
              old.role === 'assistant' &&
              old.text === text &&
              old.userId === receipt.userId &&
              old.replyToMessageId === replyToMessageId,
          );
        }
      });
    },
    retarget(permit) {
      const data = permits.get(permit);
      requireInput(data && data.confirmed === null);
      data.text = noticeTemplate('generic');
    },
    discard(permit) {
      permits.delete(permit);
    },
  };
}
const backends = new WeakMap<object, NoticeBackend>();
export function registerNotices(storage: object, backend: NoticeBackend) {
  backends.set(storage, backend);
}
export function noticeBackend(storage: object): NoticeBackend {
  const found = backends.get(storage);
  requireInput(found);
  return found;
}
