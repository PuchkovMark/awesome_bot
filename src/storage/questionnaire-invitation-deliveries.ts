import { createHash } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import type { QuestionnaireRevision } from '../contracts/questionnaire';
import type { LifecycleBackend } from './lifecycle-store';
import { readChatControl } from './chat-control-store';
import { invitationsAllowed } from './greeting-entry';
import { appendMessage } from './messages';
import { recordProfileAnswer } from './participant-derived-data';
import { questionnaireMessageSequence } from './questionnaire-types';
import { questionnaireHour } from './questionnaire-input';
import { finishResponse, responseSlotAvailable, startResponse } from './response-rate-store';

export type InvitationStage = 'warning' | 'questions';
export interface InvitationRecipient {
  readonly user: UserId;
  readonly participationRevision: number;
}

const rateKey = (id: number) => 'invitation:' + id;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const retryMs = 30_000;
const windowKey = 'id=? AND chat_id=? AND generation=?';
const bySend =
  'window_id=? AND send_id=? AND window_id IN (SELECT id FROM greeting_windows WHERE chat_id=? AND generation=?)';
const pendingConfirmation = `p.state='unknown' AND p.next_check_at<=@now
  AND p.receipt>coalesce((SELECT input_floor FROM connection_source_boundaries WHERE chat_id=w.chat_id),0)`;

export const invitationConfirmationDue = `EXISTS (
  SELECT 1 FROM questionnaire_invitation_parts p WHERE p.window_id=w.id AND ${pendingConfirmation}
)`;

export function recoverInvitationParts(db: Database, now: number) {
  db.prepare(
    `UPDATE questionnaire_invitation_parts SET state='unknown',next_check_at=?
    WHERE state='sending'`,
  ).run(now);
}

export function createInvitationDeliveries(lifecycle: LifecycleBackend) {
  return {
    reserve(
      scope: ConnectionScope,
      id: number,
      sendId: number,
      stage: InvitationStage,
      text: string,
      revision: QuestionnaireRevision,
      disclosure: number,
      recipients: readonly InvitationRecipient[],
      now: number,
      limit: number,
      current: () => boolean,
    ) {
      return lifecycle.transaction(scope, (db) => {
        const key = [id, scope.chatId, scope.generation] as const;
        const window = db
          .prepare(
            `SELECT invitation_template AS template FROM greeting_windows
          WHERE ${windowKey} AND invitation_state='waiting' AND state NOT IN ('waiting','dispatching')`,
          )
          .get(...key) as { template: string | null } | undefined;
        const pinned = JSON.stringify(revision);
        if (
          !window ||
          !recipients.length ||
          (window.template !== null && (stage !== 'questions' || window.template !== pinned)) ||
          !current() ||
          (window.template === null && !responseSlotAvailable(db, scope, limit, now)) ||
          db
            .prepare('SELECT 1 FROM greeting_windows WHERE send_id=? OR invitation_send_id=?')
            .get(sendId, sendId)
        )
          return false;
        if (
          !db
            .prepare(
              `INSERT OR IGNORE INTO questionnaire_invitation_parts
            (window_id,stage,send_id,text_hash,recipient_count,state,started_at)
            VALUES(?,?,?,?,?,'sending',?)`,
            )
            .run(id, stage, sendId, hash(text), recipients.length, now).changes
        )
          return false;
        const controls = readChatControl(db, scope.chatId);
        db.prepare(
          `UPDATE greeting_windows SET invitation_state='dispatching',
          invitation_template=coalesce(invitation_template,?),
          invitation_disclosure=coalesce(invitation_disclosure,?),
          invitation_enabled_at=coalesce(invitation_enabled_at,?),
          invitation_enabled_from=CASE WHEN invitation_template IS NULL THEN ? ELSE invitation_enabled_from END,
          invitation_send_id=CASE WHEN ?='questions' THEN ? ELSE invitation_send_id END
          WHERE ${windowKey}`,
        ).run(
          pinned,
          disclosure,
          controls.invitationEnabledAt,
          controls.invitationEnabledFrom,
          stage,
          sendId,
          ...key,
        );
        const mark = db.prepare(`UPDATE greeting_members SET invited=1,
          invitation_participation=CASE WHEN @stage='questions' THEN @participation END,
          invitation_attempt=coalesce(invitation_attempt,(
            SELECT attempt FROM questionnaire_progress WHERE (chat_id,generation,user_id)=(@chat,@generation,@user)
          )) WHERE window_id=@id AND user_id=@user`);
        for (const { user, participationRevision } of recipients)
          mark.run({
            id,
            stage,
            user,
            participation: participationRevision,
            chat: scope.chatId,
            generation: scope.generation,
          });
        if (window.template === null) startResponse(db, scope, rateKey(id), now);
        return true;
      });
    },
    received(scope: ConnectionScope, id: number, sendId: number, receipt: string) {
      const number = questionnaireMessageSequence(receipt);
      if (number === null) return;
      lifecycle.transaction(scope, (db) =>
        db
          .prepare(
            `UPDATE questionnaire_invitation_parts SET receipt=?
          WHERE ${bySend} AND state IN ('sending','unknown') AND receipt IS NULL`,
          )
          .run(number, id, sendId, scope.chatId, scope.generation),
      );
    },
    confirm(scope: ConnectionScope, id: number, sendId: number, part: PublishedPart, now: number) {
      const receipt = questionnaireMessageSequence(part.messageId);
      if (receipt === null || part.replyToMessageId !== undefined) return false;
      return lifecycle.transaction(scope, (db) => {
        const key = [id, sendId, scope.chatId, scope.generation] as const;
        const row = db
          .prepare(
            `SELECT stage, started_at AS startedAt, text_hash AS digest,
          receipt, recipient_count AS count FROM questionnaire_invitation_parts
          WHERE ${bySend} AND state IN ('sending','unknown')`,
          )
          .get(...key) as
          | {
              stage: InvitationStage;
              startedAt: number;
              digest: string;
              receipt: number | null;
              count: number;
            }
          | undefined;
        if (
          !row ||
          (row.receipt !== null && row.receipt !== receipt) ||
          part.timestamp < Math.floor(row.startedAt / 1000) * 1000 ||
          now - row.startedAt >= questionnaireHour ||
          row.digest !== hash(part.text)
        )
          return false;
        const subjects = db
          .prepare(
            `SELECT user_id FROM greeting_members WHERE window_id=?
          AND invited=1 AND (?='warning' OR invitation_participation IS NOT NULL)`,
          )
          .pluck()
          .all(id, row.stage) as UserId[];
        const forgotten = db
          .prepare(
            `SELECT 1 FROM personal_deletions
          WHERE chat_id=? AND generation=? AND confirmed_at IS NOT NULL
            AND user_id IN (SELECT value FROM json_each(?))`,
          )
          .get(scope.chatId, scope.generation, JSON.stringify(subjects));
        let messageId: number | null = null;
        if (subjects.length === row.count && !forgotten) {
          const saved = appendMessage(db, {
            ...part,
            chatId: scope.chatId,
            role: 'assistant',
            senderBot: true,
          });
          if (
            saved.status === 'inserted' ||
            db
              .prepare(
                "SELECT 1 FROM messages WHERE id=? AND user_id=? AND role='assistant' AND text=?",
              )
              .get(saved.id, part.userId, part.text)
          ) {
            db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(saved.id);
            recordProfileAnswer(db, scope, saved.id, subjects);
            messageId = saved.id;
          }
        }
        db.prepare(
          `UPDATE questionnaire_invitation_parts
          SET state='delivered',receipt=?,confirmed_at=?,next_check_at=NULL,message_id=? WHERE ${bySend}`,
        ).run(receipt, now, messageId, ...key);
        const state = readChatControl(db, scope.chatId);
        db.prepare(
          `UPDATE greeting_windows SET invitation_state=CASE
            WHEN @stage='questions' THEN 'delivered'
            WHEN @allowed AND invitation_enabled_at IS @enabledAt AND invitation_enabled_from IS @enabledFrom THEN 'waiting'
            ELSE 'skipped' END,
          invitation_message_id=CASE WHEN @stage='questions' THEN @messageId ELSE invitation_message_id END
          WHERE id=@id AND chat_id=@chat AND generation=@generation
            AND invitation_state IN ('dispatching','unknown')`,
        ).run({
          stage: row.stage,
          allowed: Number(invitationsAllowed(state, now)),
          enabledAt: state.invitationEnabledAt,
          enabledFrom: state.invitationEnabledFrom,
          messageId,
          id,
          chat: scope.chatId,
          generation: scope.generation,
        });
        finishResponse(db, scope, rateKey(id), 'delivered');
        db.prepare(
          `UPDATE response_rate_publications SET outcome='delivered'
          WHERE chat_id=? AND generation=? AND publication_key=? AND outcome='unknown'`,
        ).run(scope.chatId, scope.generation, rateKey(id));
        return true;
      });
    },
    settle(
      scope: ConnectionScope,
      id: number,
      sendId: number,
      outcome: 'failed' | 'unknown',
      now: number,
    ) {
      lifecycle.transaction(scope, (db) => {
        const changed = db
          .prepare(
            `UPDATE questionnaire_invitation_parts SET state=?,
          next_check_at=CASE WHEN ?='unknown' THEN ? END WHERE ${bySend} AND state='sending'`,
          )
          .run(outcome, outcome, now, id, sendId, scope.chatId, scope.generation);
        if (!changed.changes) return;
        db.prepare(
          `UPDATE greeting_windows SET invitation_state=? WHERE ${windowKey}
          AND invitation_state='dispatching'`,
        ).run(outcome === 'failed' ? 'skipped' : 'unknown', id, scope.chatId, scope.generation);
        finishResponse(db, scope, rateKey(id), outcome);
      });
    },
    check(scope: ConnectionScope, id: number, now: number) {
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `SELECT p.send_id AS sendId,p.receipt,p.started_at AS startedAt
          FROM questionnaire_invitation_parts p JOIN greeting_windows w ON w.id=p.window_id
          WHERE w.id=@id AND w.chat_id=@chat AND w.generation=@generation AND ${pendingConfirmation}`,
          )
          .get({ id, chat: scope.chatId, generation: scope.generation, now }) as
          { sendId: number; receipt: number; startedAt: number } | undefined;
        if (!row) return undefined;
        const retry = now - row.startedAt < questionnaireHour;
        db.prepare('UPDATE questionnaire_invitation_parts SET next_check_at=? WHERE send_id=?').run(
          retry ? now + retryMs : null,
          row.sendId,
        );
        return retry ? row : null;
      });
    },
  };
}
