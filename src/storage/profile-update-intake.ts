import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { historyBounds } from './history-retention-store';
import { profileAdmitted } from './personal-data-store';
import { requireInput } from './validation';

export interface ProfileUpdateSource {
  readonly id: number;
  readonly user: UserId;
  readonly text: string;
  readonly at: number;
}
export function sourceAdmitted(db: Database, scope: ConnectionScope, source: ProfileUpdateSource) {
  return (
    Boolean(source.text.trim()) &&
    !db
      .prepare(
        "SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=? AND status IN ('left','removed','absent')",
      )
      .get(scope.chatId, source.user) &&
    profileAdmitted(db, scope, source.user, source.at, 'write')
  );
}

export const actualMessage = "m.role='user' AND m.sender_bot=0 AND m.purpose='conversation'";

/** Вызывается при регистрации принятой обычной реплики в транзакции журнала. */
export function rememberProfileUpdate(
  db: Database,
  scope: ConnectionScope,
  messageId: number,
  now: number,
) {
  requireInput(db.inTransaction);
  const bounds = historyBounds(db, scope.chatId, now);
  const source = db
    .prepare(
      `SELECT id,user_id AS user,text,timestamp AS at FROM personal_visible_messages m
    WHERE m.chat_id=? AND m.id=? AND m.id>? AND m.timestamp>? AND ${actualMessage}`,
    )
    .get(scope.chatId, messageId, bounds.clearedThrough, bounds.expiredThrough) as
    ProfileUpdateSource | undefined;
  if (!source || !sourceAdmitted(db, scope, source)) return;
  db.prepare(
    'INSERT OR IGNORE INTO profile_update_waiting(message_id,chat_id,generation,queued_at) VALUES(?,?,?,?)',
  ).run(messageId, scope.chatId, scope.generation, now);
}
