import type { ConnectionScope } from '../contracts/index';
import { lifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';

export function questionnaireMessageSequence(id: string): number | null {
  const sequence = Number(id);
  return Number.isSafeInteger(sequence) && sequence > 0 && String(sequence) === id
    ? sequence
    : null;
}

export function legacyQuestionnairePrompts(storage: Storage) {
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
                'SELECT 1 FROM questionnaire_progress WHERE chat_id=? AND generation=? AND legacy_access_prompt_id=?',
              )
              .get(scope.chatId, scope.generation, receipt),
        )
      );
    },
  };
}
