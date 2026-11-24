import type { ConnectionScope, UserId } from '../contracts/index';
import { readChatControl } from './chat-control-store';
import { lifecycleBackend } from './lifecycle-store';
import { profileAdmitted } from './personal-data-store';
import type { Storage } from './types';
import { requireInput, timestamp } from './validation';

export type QuestionnaireAccessDecision = 'open' | 'closed';

export function questionnaireMessageSequence(id: string): number | null {
  const sequence = Number(id);
  return Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === id
    ? sequence
    : null;
}

export function questionnaireAccessStore(storage: Storage) {
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
                'SELECT 1 FROM questionnaire_access WHERE chat_id=? AND generation=? AND prompt_message_id=?',
              )
              .get(scope.chatId, scope.generation, receipt),
        )
      );
    },
    confirmPrompt(
      scope: ConnectionScope,
      user: UserId,
      attempt: string,
      messageId: string,
      at: number,
    ) {
      const receipt = questionnaireMessageSequence(messageId);
      timestamp(at);
      requireInput(receipt !== null);
      return lifecycle.transaction(scope, (db) => {
        if (!profileAdmitted(db, scope, user, at)) return false;
        return (
          db
            .prepare(
              `UPDATE questionnaire_access SET prompt_message_id=@receipt,prompt_delivered_at=@at
          WHERE (chat_id,generation,user_id,attempt)=(@chat,@generation,@user,@attempt)
          AND prompt_message_id IS NULL AND @receipt>coalesce(response_message_id,0)`,
            )
            .run({ chat: scope.chatId, generation: scope.generation, user, attempt, receipt, at })
            .changes === 1
        );
      });
    },
    decide(
      scope: ConnectionScope,
      user: UserId,
      decision: QuestionnaireAccessDecision,
      event: { readonly sequence: number; readonly at: number; readonly receipt: number | null },
    ): 'applied' | 'unavailable' | 'ignored' {
      timestamp(event.at);
      return lifecycle.transaction(scope, (db) => {
        const { enabled } = readChatControl(db, scope.chatId);
        if (!enabled || !profileAdmitted(db, scope, user, event.at, 'write')) return 'ignored';
        const key = { chat: scope.chatId, generation: scope.generation, user };
        if (
          db
            .prepare(
              `UPDATE questionnaire_access SET decision=@decision,decision_message_id=@sequence
          WHERE (chat_id,generation,user_id)=(@chat,@generation,@user)
          AND @sequence>max(coalesce(response_message_id,0),coalesce(decision_message_id,0))
          AND (@receipt IS NULL OR (prompt_message_id=@receipt AND @sequence>@receipt))`,
            )
            .run({ ...key, decision, sequence: event.sequence, receipt: event.receipt }).changes ===
          1
        )
          return 'applied';
        if (event.receipt !== null) return 'ignored';
        return db
          .prepare(
            'SELECT 1 FROM questionnaire_access WHERE (chat_id,generation,user_id)=(@chat,@generation,@user)',
          )
          .get(key)
          ? 'ignored'
          : 'unavailable';
      });
    },
  };
}
