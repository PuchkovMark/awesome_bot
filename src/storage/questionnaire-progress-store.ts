import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import type { QuestionnaireRevision } from '../contracts/questionnaire';
import type { Storage } from './types';
import { lifecycleBackend } from './lifecycle-store';
import {
  questionnaireSource,
  acceptQuestionnaireInput,
  questionnaireHour,
} from './questionnaire-input';
import { profileAdmitted } from './personal-data-store';
import { questionnaireStore } from './questionnaire-store';
import { timestamp } from './validation';

const subject = 'chat_id=? AND generation=? AND user_id=?';

type State = 'showing' | 'dispatching' | 'active' | 'paused' | 'processing' | 'completed';
interface Row {
  attempt: string;
  presentation: string;
  template: string;
  state: State;
  shown_at: number | null;
  source_id: number | null;
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
    return {
      current(now: number) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
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
      takePresentation(now: number) {
        timestamp(now);
        return lifecycle.transaction(scope, (db) => {
          const row = read(db);
          if (row?.state !== 'showing' || !profileAdmitted(db, scope, user, now)) return null;
          db.prepare("UPDATE questionnaire_progress SET state='dispatching' WHERE " + subject).run(
            ...key,
          );
          const { template } = view(row, now);
          return {
            presentation: row.presentation,
            text: template.questions.map((q) => q.text).join('\n'),
          };
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
            "UPDATE questionnaire_progress SET state='showing',shown_at=NULL,presentation=? WHERE " +
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
  }
  function pending(db: Database, scope: ConnectionScope, id: number, now: number) {
    const row = db
      .prepare(
        "SELECT p.* FROM questionnaire_progress p JOIN questionnaire_inputs i ON i.chat_id=p.chat_id AND i.generation=p.generation AND i.attempt=p.attempt AND i.message_id=p.source_id WHERE p.chat_id=? AND p.generation=? AND i.message_id=? AND p.state='processing'",
      )
      .get(scope.chatId, scope.generation, id) as (Row & { user_id: UserId }) | undefined;
    if (!row) return null;
    const msg = questionnaireSource(db, scope, row.user_id, id, now);
    return msg && { template: view(row, now).template, text: msg.text, user: row.user_id };
  }
  return {
    participant,
    completed(scope: ConnectionScope, user: UserId) {
      return lifecycle.transaction(scope, (db) =>
        Boolean(
          db
            .prepare(
              'SELECT 1 FROM questionnaire_progress WHERE ' + subject + " AND state='completed'",
            )
            .get(scope.chatId, scope.generation, user),
        ),
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
        return (
          db
            .prepare(
              "UPDATE questionnaire_progress SET state='completed',answers=? WHERE " +
                subject +
                " AND state='processing' AND source_id=?",
            )
            .run(JSON.stringify(answers), scope.chatId, scope.generation, input.user, id)
            .changes === 1
        );
      });
    },
  };
}
