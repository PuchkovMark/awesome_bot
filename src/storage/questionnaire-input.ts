import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { profileAdmitted } from './personal-data-store';
import { participantProfileAvailable, readDeparture } from './participant-departures';
import { historyBounds } from './history-retention-store';
import { timestamp } from './validation';
export const questionnaireHour = 3_600_000;
const subject = 'chat_id=? AND generation=? AND user_id=?';
export function isQuestionnaireMember(db: Database, scope: ConnectionScope, user: UserId) {
  return (
    participantProfileAvailable(readDeparture(db, scope, user)) &&
    !!db
      .prepare("SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=? AND status='present'")
      .get(scope.chatId, user)
  );
}

export function questionnaireSource(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  id: number,
  now: number,
  pending = false,
) {
  const bounds = historyBounds(db, scope.chatId, now);
  const message = db
    .prepare(
      "SELECT text,timestamp,platform_message_id AS platformMessageId FROM personal_visible_messages WHERE id=? AND chat_id=? AND user_id=? AND role='user' AND purpose=? AND sender_bot IS NOT 1 AND id>? AND timestamp>?",
    )
    .get(
      id,
      scope.chatId,
      user,
      pending ? 'service_notice' : 'conversation',
      bounds.clearedThrough,
      bounds.expiredThrough,
    ) as { text: string; timestamp: number; platformMessageId: string } | undefined;
  return message && profileAdmitted(db, scope, user, message.timestamp, 'write') ? message : null;
}

export function answerableAttempt(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  messageId: number,
  receivedAt: number,
) {
  timestamp(receivedAt);
  if (scope.chatId === user) return null;
  const key = [scope.chatId, scope.generation, user] as const;
  const row = db
    .prepare(
      'SELECT attempt,shown_message_id AS shownMessageId FROM questionnaire_progress WHERE ' +
        subject +
        " AND state='active' AND shown_at<=? AND shown_at>?",
    )
    .get(...key, receivedAt, receivedAt - questionnaireHour) as
    { attempt: string; shownMessageId: number | null } | undefined;
  if (!row) return null;
  const source = questionnaireSource(db, scope, user, messageId, receivedAt);
  if (!source) return null;
  const sequence = Number(source.platformMessageId);
  if (
    row.shownMessageId !== null &&
    (!Number.isSafeInteger(sequence) ||
      String(sequence) !== source.platformMessageId ||
      sequence <= row.shownMessageId)
  )
    return null;
  return row.attempt;
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
  const attempt = answerableAttempt(db, scope, user, messageId, receivedAt);
  if (!attempt || (expectedAttempt !== undefined && expectedAttempt !== attempt)) return false;
  return markQuestionnaireInput(db, scope, user, attempt, messageId);
}

export function markQuestionnaireInput(
  db: Database,
  scope: ConnectionScope,
  user: UserId,
  attempt: string,
  messageId: number,
) {
  if (
    !db
      .prepare('INSERT OR IGNORE INTO questionnaire_inputs VALUES(?,?,?,?)')
      .run(messageId, scope.chatId, scope.generation, attempt).changes
  )
    return false;
  db.prepare(
    "UPDATE questionnaire_progress SET state='processing',source_id=? WHERE " + subject,
  ).run(messageId, scope.chatId, scope.generation, user);
  db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(messageId);
  return true;
}
