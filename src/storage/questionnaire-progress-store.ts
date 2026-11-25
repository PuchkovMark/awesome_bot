import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, PublishedPart, UserId } from '../contracts/index';
import type { QuestionnaireRevision } from '../contracts/questionnaire';
import type { Storage } from './types';
import { lifecycleBackend } from './lifecycle-store';
import {
  questionnaireSource,
  acceptQuestionnaireInput,
  answerableAttempt,
  questionnaireHour,
} from './questionnaire-input';
import { profileAdmitted } from './personal-data-store';
import { participantProfileAvailable, readDeparture } from './participant-departures';
import { questionnaireStore } from './questionnaire-store';
import { claimControlMessage, readChatControl } from './chat-control-store';
import { requireInput, timestamp } from './validation';
import { appendMessage } from './messages';
import { recordQuestionnaireFacts } from './profile-fact-store';
import { questionnaireMessageSequence } from './questionnaire-access-store';

const subject = 'chat_id=? AND generation=? AND user_id=?';

type State = 'showing' | 'dispatching' | 'active' | 'paused' | 'processing' | 'completed';
export type QuestionnaireCommand = 'open' | 'pause' | 'cancel';
type CommandResult =
  | { readonly kind: 'showing'; readonly presentation: string }
  | {
      readonly kind:
        | Exclude<State, 'showing'>
        | 'cancelled'
        | 'idle'
        | 'unconfigured'
        | 'duplicate'
        | 'forbidden'
        | 'profile_required';
    };
interface Row {
  attempt: string;
  presentation: string;
  template: string;
  state: State;
  shown_at: number | null;
  source_id: number | null;
  warning_delivered: number;
}

function view(row: Row, now: number) {
  const template = JSON.parse(row.template) as QuestionnaireRevision;
  const paused =
    row.state === 'active' && row.shown_at !== null && now - row.shown_at >= questionnaireHour;
  return {
    attempt: row.attempt,
    presentation: row.presentation,
    template,
    state: paused ? ('paused' as const) : row.state,
  };
}

export function questionnaireProgressStore(storage: Storage) {
  const lifecycle = lifecycleBackend(storage);
  const templates = questionnaireStore(storage);
  function participant(scope: ConnectionScope, user: UserId) {
    const key = [scope.chatId, scope.generation, user] as const;
    function read(db: Database) {
      return db.prepare('SELECT * FROM questionnaire_progress WHERE ' + subject).get(...key) as
        Row | undefined;
    }
    const actor = {
      current(now: number) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          if (!participantProfileAvailable(readDeparture(db, scope, user))) return null;
          const row = read(db);
          return row ? view(row, now) : null;
        });
      },
      open(now: number, revision = () => templates.current(scope)) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          if (!profileAdmitted(db, scope, user, now)) return null;
          const row = read(db);
          if (row) return view(row, now);
          const selected = revision();
          if (
            !selected ||
            selected.ref.chatId !== scope.chatId ||
            selected.ref.generation !== scope.generation
          )
            return null;
          db.prepare(
            "INSERT INTO questionnaire_progress(chat_id,generation,user_id,attempt,presentation,template,state) VALUES(?,?,?,?,?,?,'showing')",
          ).run(...key, randomUUID(), randomUUID(), JSON.stringify(selected));
          return view(read(db)!, now);
        });
      },
      takePresentation(now: number, expected?: string) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          const row = read(db);
          if (
            row?.state !== 'showing' ||
            (expected !== undefined && row.presentation !== expected) ||
            !profileAdmitted(db, scope, user, now)
          )
            return null;
          db.prepare("UPDATE questionnaire_progress SET state='dispatching' WHERE " + subject).run(
            ...key,
          );
          const { template } = view(row, now);
          return {
            presentation: row.presentation,
            warningDelivered: row.warning_delivered === 1,
            text: template.questions.map((q) => q.text).join('\n'),
          };
        });
      },
      presenting(presentation: string, now: number) {
        return lifecycle.transaction(scope, (db) => {
          const row = read(db);
          return (
            row?.state === 'dispatching' &&
            row.presentation === presentation &&
            profileAdmitted(db, scope, user, now)
          );
        });
      },
      confirmPresentation(
        presentation: string,
        stage: 'warning' | 'questions',
        part: PublishedPart,
        at: number,
        current: () => boolean,
      ) {
        timestamp(at);
        const receipt = Number(part.messageId);
        requireInput(
          Number.isSafeInteger(receipt) &&
            receipt > 0 &&
            part.messageId === String(receipt) &&
            part.replyToMessageId === undefined,
        );
        return lifecycle.transaction(scope, (db) => {
          if (!current()) return false;
          const row = read(db);
          if (
            row?.state !== 'dispatching' ||
            row.presentation !== presentation ||
            !profileAdmitted(db, scope, user, at)
          )
            return false;
          const saved = appendMessage(db, {
            chatId: scope.chatId,
            role: 'assistant',
            senderBot: true,
            messageId: part.messageId,
            userId: part.userId,
            authorName: part.authorName,
            text: part.text,
            timestamp: part.timestamp,
          });
          requireInput(saved.status === 'inserted');
          db.prepare("UPDATE messages SET purpose='service_notice' WHERE id=?").run(saved.id);
          if (stage === 'warning')
            db.prepare(
              "UPDATE questionnaire_progress SET state='showing',warning_delivered=1 WHERE " +
                subject,
            ).run(...key);
          else
            db.prepare(
              "UPDATE questionnaire_progress SET state='active',shown_at=?,shown_message_id=? WHERE " +
                subject,
            ).run(at, receipt, ...key);
          return true;
        });
      },
      deliveryFailed(presentation: string) {
        return lifecycle.transaction(
          scope,
          (db) =>
            db
              .prepare(
                "UPDATE questionnaire_progress SET state='showing' WHERE " +
                  subject +
                  " AND presentation=? AND state='dispatching'",
              )
              .run(...key, presentation).changes === 1,
        );
      },
      shown(presentation: string, at: number) {
        timestamp(at);
        return lifecycle.transaction(
          scope,
          (db) =>
            db
              .prepare(
                "UPDATE questionnaire_progress SET state='active',shown_at=? WHERE " +
                  subject +
                  " AND presentation=? AND state='dispatching'",
              )
              .run(at, ...key, presentation).changes === 1,
        );
      },
      pause(attempt: string) {
        return lifecycle.transaction(
          scope,
          (db) =>
            db
              .prepare(
                "UPDATE questionnaire_progress SET state='paused' WHERE " +
                  subject +
                  " AND attempt=? AND state IN ('active','showing','dispatching','processing')",
              )
              .run(...key, attempt).changes === 1,
        );
      },
      resume(attempt: string, now: number) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          const row = read(db);
          if (
            !row ||
            row.attempt !== attempt ||
            view(row, now).state !== 'paused' ||
            !profileAdmitted(db, scope, user, now)
          )
            return null;
          db.prepare(
            "UPDATE questionnaire_progress SET state='showing',shown_at=NULL,shown_message_id=NULL,warning_delivered=0,source_id=NULL,presentation=? WHERE " +
              subject,
          ).run(randomUUID(), ...key);
          return view(read(db)!, now);
        });
      },
      cancel(attempt: string) {
        return lifecycle.transaction(
          scope,
          (db) =>
            db
              .prepare(
                'DELETE FROM questionnaire_progress WHERE ' +
                  subject +
                  " AND attempt=? AND state<>'completed'",
              )
              .run(...key, attempt).changes === 1,
        );
      },
      accept(attempt: string, messageId: number, receivedAt: number) {
        return lifecycle.transaction(scope, (db) =>
          acceptQuestionnaireInput(db, scope, user, messageId, receivedAt, attempt),
        );
      },
    };
    return {
      ...actor,
      command(
        action: QuestionnaireCommand,
        event: { readonly sequence: number; readonly at: number },
        now: number,
        revision: () => QuestionnaireRevision | null,
      ): CommandResult {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          const state = readChatControl(db, scope.chatId);
          if (!state.enabled || state.mode === 'silent') return { kind: 'forbidden' };
          if (!profileAdmitted(db, scope, user, event.at, 'write'))
            return { kind: 'profile_required' };
          if (
            !claimControlMessage(db, scope.chatId, user, {
              sourceChatId: scope.chatId,
              messageId: event.sequence,
              timestamp: event.at,
            })
          )
            return { kind: 'duplicate' };

          const existing = actor.current(now);
          if (existing?.state === 'completed') return { kind: 'completed' };
          if (action === 'cancel')
            return { kind: existing && actor.cancel(existing.attempt) ? 'cancelled' : 'idle' };
          if (action === 'pause') {
            if (!existing) return { kind: 'idle' };
            actor.pause(existing.attempt);
            return { kind: 'paused' };
          }
          const next = !existing
            ? actor.open(now, revision)
            : existing.state === 'paused'
              ? actor.resume(existing.attempt, now)
              : existing;
          if (!next) return { kind: 'unconfigured' };
          return next.state === 'showing'
            ? { kind: 'showing', presentation: next.presentation }
            : { kind: next.state };
        });
      },
    };
  }
  function pending(db: Database, scope: ConnectionScope, id: number, now: number) {
    const row = db
      .prepare(
        "SELECT p.* FROM questionnaire_progress p JOIN questionnaire_inputs i ON i.chat_id=p.chat_id AND i.generation=p.generation AND i.attempt=p.attempt AND i.message_id=p.source_id WHERE p.chat_id=? AND p.generation=? AND i.message_id=? AND p.state='processing'",
      )
      .get(scope.chatId, scope.generation, id) as (Row & { user_id: UserId }) | undefined;
    if (!row) return null;
    const msg = questionnaireSource(db, scope, row.user_id, id, now, true);
    return (
      msg && { ...msg, attempt: row.attempt, template: view(row, now).template, user: row.user_id }
    );
  }
  function completionRevision(scope: ConnectionScope, user: UserId, expectedAttempt?: string) {
    return lifecycle.transaction(scope, (db) => {
      const state = readDeparture(db, scope, user);
      if (!participantProfileAvailable(state)) return null;
      const completed = db
        .prepare(
          'SELECT attempt FROM questionnaire_progress WHERE ' + subject + " AND state='completed'",
        )
        .pluck()
        .get(scope.chatId, scope.generation, user);
      return completed && (expectedAttempt === undefined || completed === expectedAttempt)
        ? (state?.revision ?? 0)
        : null;
    });
  }

  return {
    participant,
    completionRevision,
    canAnswer(scope: ConnectionScope, user: UserId, messageId: number, receivedAt: number) {
      return lifecycle.transaction(
        scope,
        (db) => answerableAttempt(db, scope, user, messageId, receivedAt) !== null,
      );
    },
    participating(scope: ConnectionScope, user: UserId) {
      return lifecycle.transaction(scope, (db) =>
        participantProfileAvailable(readDeparture(db, scope, user)),
      );
    },
    owns(scope: ConnectionScope, id: number) {
      return lifecycle.transaction(scope, (db) =>
        Boolean(
          db
            .prepare(
              'SELECT 1 FROM questionnaire_inputs WHERE chat_id=? AND generation=? AND message_id=?',
            )
            .get(scope.chatId, scope.generation, id),
        ),
      );
    },
    pending(scope: ConnectionScope, id: number, now: number) {
      return lifecycle.transaction(scope, (db) => pending(db, scope, id, now));
    },
    finish(
      scope: ConnectionScope,
      id: number,
      now: number,
      answers: Readonly<Record<string, string>>,
      current: () => boolean,
    ) {
      return lifecycle.transaction(scope, (db) => {
        if (!current()) return false;
        const input = pending(db, scope, id, now);
        if (
          !input ||
          !Object.entries(answers).every(
            ([key, value]) =>
              input.template.questions.some((q) => String(q.position) === key) &&
              value.trim() &&
              input.text.includes(value),
          )
        )
          return false;
        const { user, attempt, template, platformMessageId, timestamp: sourceAt, text } = input;
        const completed = db
          .prepare(
            "UPDATE questionnaire_progress SET state='completed',answers=NULL,response_message_id=? WHERE " +
              subject +
              " AND state='processing' AND source_id=?",
          )
          .run(
            questionnaireMessageSequence(platformMessageId),
            scope.chatId,
            scope.generation,
            user,
            id,
          );
        if (completed.changes !== 1) return false;
        recordQuestionnaireFacts(
          db,
          scope,
          attempt,
          template,
          { userId: user, messageId: platformMessageId, at: sourceAt, text },
          answers,
          now,
        );
        return true;
      });
    },
  };
}
