import type { Storage } from '../../storage/types';
import { questionnaireProgressStore } from '../../storage/questionnaire-progress-store';
import type { QuestionnaireInvitationSource } from '../greetings/invitation';

export function createQuestionnaireProgress(storage: Storage) {
  const store = questionnaireProgressStore(storage);
  return {
    participant: store.participant,
    invitations(entry?: QuestionnaireInvitationSource): QuestionnaireInvitationSource {
      return {
        action(scope) {
          return entry?.action(scope) ?? null;
        },
        state(scope, user) {
          if (store.completionRevision(scope, user) !== null) return 'completed';
          if (!store.participating(scope, user)) return 'unavailable';
          return entry?.state(scope, user) ?? 'unavailable';
        },
      };
    },
  };
}
