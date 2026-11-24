import type { Database } from 'better-sqlite3';
import type { ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import { readChatControl } from './chat-control-store';
import { lifecycleBackend } from './lifecycle-store';
import { appendMessage } from './messages';
import { profileAdmitted } from './personal-data-store';
import { recordProfileAnswer } from './participant-derived-data';
import { questionnaireMessageSequence } from './questionnaire-access-store';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

export interface QuestionnairePresentationTarget {
  readonly user: UserId;
  readonly attempt: string;
}
export interface QuestionnairePresentationGrant extends QuestionnairePresentationTarget {
  readonly event: number;
}
type PublicationOutcome = 'delivered' | 'failed' | 'unknown';
const keys = '(chat_id,generation,user_id,attempt)=(@chat,@generation,@user,@attempt)';

function parameters(scope: ConnectionScope, target: QuestionnairePresentationTarget) {
  return { chat: scope.chatId, generation: scope.generation, ...target };
}

function journal(db: Database, scope: ConnectionScope, user: UserId, part: PublishedPart) {
  const saved = appendMessage(db, {
    ...part,
    chatId: scope.chatId,
    role: 'assistant',
    senderBot: true,
  });
  requireInput(saved.status === 'inserted');
  db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(saved.id);
  recordProfileAnswer(db, scope, saved.id, [user]);
}

export function questionnairePresentationStore(storage: Storage) {
  const lifecycle = lifecycleBackend(storage);
  return {
    hasPrompt(scope: ConnectionScope, messageId: string) {
      const receipt = questionnaireMessageSequence(messageId);
      return (
        receipt !== null &&
        lifecycle.transaction(
          scope,
          (db) =>
            !!db
              .prepare(
                'SELECT 1 FROM questionnaire_presentations WHERE chat_id=? AND generation=? AND prompt_message_id=?',
              )
              .get(scope.chatId, scope.generation, receipt),
        )
      );
    },
    canPrompt(scope: ConnectionScope, target: QuestionnairePresentationTarget) {
      return lifecycle.transaction(
        scope,
        (db) =>
          !!db
            .prepare(
              `SELECT 1 FROM questionnaire_progress WHERE state='completed' AND ${keys}
          AND NOT EXISTS(SELECT 1 FROM questionnaire_presentations WHERE ${keys})`,
            )
            .get(parameters(scope, target)),
      );
    },
    confirmPrompt(
      scope: ConnectionScope,
      target: QuestionnairePresentationTarget,
      part: PublishedPart,
    ) {
      const receipt = questionnaireMessageSequence(part.messageId);
      requireInput(receipt !== null);
      return lifecycle.transaction(scope, (db) => {
        const row = db
          .prepare(
            `INSERT INTO questionnaire_presentations(chat_id,generation,user_id,attempt,prompt_message_id)
          SELECT chat_id,generation,user_id,attempt,@receipt FROM questionnaire_progress
          WHERE state='completed' AND ${keys} AND @receipt>coalesce(response_message_id,0)
          ON CONFLICT(chat_id,generation,user_id,attempt) DO NOTHING`,
          )
          .run({ ...parameters(scope, target), receipt });
        if (row.changes === 1) journal(db, scope, target.user, part);
        return row.changes === 1;
      });
    },
    decide(
      scope: ConnectionScope,
      user: UserId,
      approve: boolean,
      event: { readonly sequence: number; readonly at: number; readonly receipt: number | null },
    ):
      | { readonly kind: 'approved'; readonly grant: QuestionnairePresentationGrant }
      | { readonly kind: 'declined' | 'unavailable' | 'ignored' } {
      timestamp(event.at);
      return lifecycle.transaction(scope, (db) => {
        const { enabled, mode } = readChatControl(db, scope.chatId);
        if (!enabled || mode === 'silent' || !profileAdmitted(db, scope, user, event.at, 'write'))
          return { kind: 'ignored' };
        const row = db
          .prepare(
            `SELECT a.attempt,a.response_message_id AS response,p.prompt_message_id AS prompt
          FROM questionnaire_progress a LEFT JOIN questionnaire_presentations p USING(chat_id,generation,user_id,attempt)
          WHERE a.state='completed' AND (a.chat_id,a.generation,a.user_id)=(?,?,?)`,
          )
          .get(scope.chatId, scope.generation, user) as
          { attempt: string; response: number | null; prompt: number | null } | undefined;
        if (!row) return { kind: event.receipt === null ? 'unavailable' : 'ignored' };
        if (
          event.sequence <= (row.response ?? 0) ||
          (event.receipt !== null &&
            (event.receipt !== row.prompt || event.sequence <= event.receipt))
        )
          return { kind: 'ignored' };
        const grant = { user, attempt: row.attempt, event: event.sequence };
        const result = db
          .prepare(
            `INSERT INTO questionnaire_presentations(chat_id,generation,user_id,attempt,event_id,state)
          VALUES(@chat,@generation,@user,@attempt,@event,@state)
          ON CONFLICT(chat_id,generation,user_id,attempt) DO UPDATE SET event_id=excluded.event_id,state=excluded.state
          WHERE state IN ('waiting','declined','failed') AND @event>coalesce(event_id,0)`,
          )
          .run({ ...parameters(scope, grant), state: approve ? 'sending' : 'declined' });
        if (!result.changes) return { kind: 'ignored' };
        return approve ? { kind: 'approved', grant } : { kind: 'declined' };
      });
    },
    current(scope: ConnectionScope, grant: QuestionnairePresentationGrant) {
      return lifecycle.transaction(
        scope,
        (db) =>
          !!db
            .prepare(
              `SELECT 1 FROM questionnaire_presentations WHERE ${keys} AND event_id=@event AND state='sending'`,
            )
            .get(parameters(scope, grant)),
      );
    },
    confirmPart(
      scope: ConnectionScope,
      grant: QuestionnairePresentationGrant,
      part: PublishedPart,
    ) {
      lifecycle.transaction(scope, (db) => {
        const changed = db
          .prepare(
            `UPDATE questionnaire_presentations SET confirmed_parts=confirmed_parts+1
          WHERE ${keys} AND event_id=@event AND state='sending'`,
          )
          .run(parameters(scope, grant));
        requireInput(changed.changes === 1);
        journal(db, scope, grant.user, part);
      });
    },
    finish(
      scope: ConnectionScope,
      grant: QuestionnairePresentationGrant,
      outcome: PublicationOutcome,
    ) {
      lifecycle.transaction(scope, (db) => {
        db.prepare(
          `UPDATE questionnaire_presentations
          SET state=CASE WHEN @outcome='failed' AND confirmed_parts<>0 THEN 'unknown' ELSE @outcome END
          WHERE ${keys} AND event_id=@event AND state='sending'`,
        ).run({ ...parameters(scope, grant), outcome });
      });
    },
  };
}
