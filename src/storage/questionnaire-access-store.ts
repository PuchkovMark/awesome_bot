import type { ConnectionScope } from '../contracts/index';
import { lifecycleBackend } from './lifecycle-store';
import type { Storage } from './types';
import { questionnaireMessageSequence } from './questionnaire-types';

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
                `SELECT 1 FROM questionnaire_progress WHERE chat_id=@chat AND generation=@generation AND legacy_access_prompt_id=@receipt
                UNION ALL SELECT 1 FROM questionnaire_presentations WHERE chat_id=@chat AND generation=@generation AND prompt_message_id=@receipt
                UNION ALL SELECT 1 FROM questionnaire_management_prompts WHERE chat_id=@chat AND generation=@generation AND receipt=@receipt AND expires_at=0`,
              )
              .get({ chat: scope.chatId, generation: scope.generation, receipt }),
        )
      );
    },
  };
}
