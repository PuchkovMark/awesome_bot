import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { profileAdmitted } from './personal-data-store';
import { historyBounds } from './history-retention-store';
import { timestamp } from './validation';
export const questionnaireHour = 3_600_000;
const subject = 'chat_id=? AND generation=? AND user_id=?';
export function questionnaireSource(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  id: number,
  now: number,
) {
  const bounds = historyBounds(db, scope.chatId, now);
  const message = db
    .prepare(
      "SELECT text,timestamp FROM personal_visible_messages WHERE id=? AND chat_id=? AND user_id=? AND role='user' AND purpose='conversation' AND sender_bot IS NOT 1 AND id>? AND timestamp>?",
    )
    .get(id, scope.chatId, user, bounds.clearedThrough, bounds.expiredThrough) as
    { text: string; timestamp: number } | undefined;
  return message && profileAdmitted(db, scope, user, message.timestamp, 'write') ? message : null;
}

/** В одной транзакции с допуском задания. Повтор, переполнение или чужое сообщение не занимают попытку. */
export function acceptQuestionnaireInput(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  messageId: number,
  receivedAt: number,
  expectedAttempt?: string,
) {
  timestamp(receivedAt);
  const key = [scope.chatId, scope.generation, user] as const;
  const row = db
    .prepare(
      'SELECT attempt FROM questionnaire_progress WHERE ' +
        subject +
        " AND state='active' AND shown_at<=? AND shown_at>?",
    )
    .get(...key, receivedAt, receivedAt - questionnaireHour) as { attempt: string } | undefined;
  if (
    !row ||
    (expectedAttempt !== undefined && expectedAttempt !== row.attempt) ||
    !questionnaireSource(db, scope, user, messageId, receivedAt)
  )
    return false;
  if (
    !db
      .prepare('INSERT OR IGNORE INTO questionnaire_inputs VALUES(?,?,?,?)')
      .run(messageId, scope.chatId, scope.generation, row.attempt).changes
  )
    return false;
  db.prepare(
    "UPDATE questionnaire_progress SET state='processing',source_id=? WHERE " + subject,
  ).run(messageId, ...key);
  return true;
}
