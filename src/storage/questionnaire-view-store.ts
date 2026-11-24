import type { Database } from 'better-sqlite3';
import type { ConnectionScope, UserId } from '../contracts/index';
import { readDisclosureGate } from './chat-disclosure-store';
import { lifecycleBackend } from './lifecycle-store';
import { participantProfileAvailable, readDeparture } from './participant-departures';
import { profileAdmitted } from './personal-data-store';
import { publiclyVisibleFact, selectCurrentFacts } from './profile-fact-selection';
import type { Storage } from './types';

export function isQuestionnaireMember(db: Database, scope: ConnectionScope, user: UserId) {
  return (
    participantProfileAvailable(readDeparture(db, scope, user)) &&
    !!db
      .prepare("SELECT 1 FROM chat_participants WHERE chat_id=? AND user_id=? AND status='present'")
      .get(scope.chatId, user)
  );
}

export function questionnaireViewStore(storage: Storage) {
  const lifecycle = lifecycleBackend(storage);
  function read(
    scope: ConnectionScope,
    delivery: ConnectionScope,
    requester: UserId,
    author: UserId,
    now: number,
    purpose: 'view' | 'presentation' = 'view',
  ) {
    const privateDelivery = delivery.chatId === requester;
    const ownPrivateDelivery = privateDelivery && requester === author;
    const groupSource = scope.chatId !== author;
    if (
      (!privateDelivery && delivery.chatId !== scope.chatId) ||
      (scope.chatId === requester && requester !== author) ||
      (!groupSource && !ownPrivateDelivery)
    )
      return null;

    return lifecycle.transaction(scope, (db) => {
      lifecycle.assertScope(db, delivery);
      if (
        !db.prepare('SELECT 1 FROM chats WHERE chat_id=? AND enabled=1').get(scope.chatId) ||
        !profileAdmitted(db, scope, author, now) ||
        (groupSource &&
          (!isQuestionnaireMember(db, scope, author) ||
            !isQuestionnaireMember(db, scope, requester)))
      )
        return null;
      const questionnaire = db
        .prepare(
          "SELECT attempt FROM questionnaire_progress WHERE (chat_id,generation,user_id)=(?,?,?) AND state='completed'",
        )
        .get(scope.chatId, scope.generation, author) as { attempt: string } | undefined;
      if (!questionnaire) return { attempt: null, pairs: [], signature: 'unfilled' };

      const facts = selectCurrentFacts(db, scope, { kind: 'profile', subjectId: author }, now);
      const selected = facts
        .flatMap((fact) => {
          const { row } = fact;
          return row.questionnaireAttempt === questionnaire.attempt &&
            row.question !== null &&
            row.questionPosition !== null &&
            (purpose === 'presentation'
              ? fact.visibility === 'chat'
              : ownPrivateDelivery || publiclyVisibleFact(fact))
            ? [
                {
                  position: row.questionPosition,
                  question: row.question,
                  answer: row.value,
                  id: row.id,
                  restriction: fact.restrictionId,
                },
              ]
            : [];
        })
        .sort((a, b) => a.position - b.position);
      return {
        attempt: questionnaire.attempt,
        pairs: selected.map(({ question, answer }) => ({ question, answer })),
        signature: JSON.stringify([
          questionnaire.attempt,
          readDisclosureGate(db, scope).version,
          readDeparture(db, scope, author)?.revision ?? 0,
          readDeparture(db, scope, requester)?.revision ?? 0,
          selected.map(({ id, restriction }) => [id, restriction]),
        ]),
      };
    });
  }
  return {
    read,
    presentation(scope: ConnectionScope, author: UserId, now: number) {
      return scope.chatId === author
        ? null
        : read(scope, scope, author, author, now, 'presentation');
    },
  };
}
