import type { ConnectionScope, UserId } from '../../contracts/index';
import type { Storage } from '../../storage/types';
import {
  questionnaireProgressStore,
  type QuestionnaireCommand,
} from '../../storage/questionnaire-progress-store';
import { questionnaireStore } from '../../storage/questionnaire-store';
import type { QuestionnaireInvitationSource } from '../greetings/invitation';

export function createQuestionnaireProgress(storage: Storage) {
  const store = questionnaireProgressStore(storage);
  const groups = questionnaireStore(storage);
  function revision(scope: ConnectionScope, user: UserId) {
    return scope.chatId === user ? null : groups.current(scope);
  }
  return {
    revision,
    participant(scope: ConnectionScope, user: UserId) {
      const actor = store.participant(scope, user);
      return {
        ...actor,
        open: (now: number) => actor.open(now, () => revision(scope, user)),
        command: (
          action: QuestionnaireCommand,
          event: { readonly sequence: number; readonly at: number },
          now: number,
        ) => actor.command(action, event, now, () => revision(scope, user)),
      };
    },
    invitations(
      entry?: Pick<QuestionnaireInvitationSource, 'state'>,
    ): QuestionnaireInvitationSource {
      return {
        revision: groups.current,
        state(scope, user) {
          if (store.completionRevision(scope, user) !== null) return 'completed';
          if (!store.participating(scope, user)) return 'unavailable';
          return entry?.state(scope, user) ?? 'unavailable';
        },
      };
    },
  };
}
