import type { ConnectionScope, UserId } from '../../contracts/index';
import type { Storage } from '../../storage/types';
import { questionnaireProgressStore } from '../../storage/questionnaire-progress-store';
import { questionnaireStore } from '../../storage/questionnaire-store';
import type { QuestionnaireInvitationSource } from '../greetings/invitation';
import { privateQuestionnaire } from '../questionnaires/private-template';

export function createQuestionnaireProgress(storage: Storage) {
  const store = questionnaireProgressStore(storage);
  const groups = questionnaireStore(storage);
  function revision(scope: ConnectionScope, user: UserId) {
    if (scope.chatId !== user) return groups.current(scope);
    const { key, revision, questions } = privateQuestionnaire;
    return {
      ref: { chatId: scope.chatId, generation: scope.generation, key, revision },
      questions,
    };
  }
  return {
    revision,
    participant(scope: ConnectionScope, user: UserId) {
      const actor = store.participant(scope, user);
      return {
        ...actor,
        open: (now: number) => actor.open(now, () => revision(scope, user)),
      };
    },
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
