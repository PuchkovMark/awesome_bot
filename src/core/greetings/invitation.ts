import type { ConnectionScope, PublishedPart, UserId } from '../../contracts/index';
import type { greetingStore } from '../../storage/greeting-store';
import type { ResponseRateOutcome } from '../../storage/response-rate-store';
import type { IntroductionGuard, WritePermission } from '../chat-onboarding/ports';

export interface QuestionnaireInvitationSource {
  action(scope: ConnectionScope): string | null;
  state(scope: ConnectionScope, user: UserId): 'available' | 'completed' | 'unavailable';
}

export interface QuestionnaireInvitationDispatch {
  readonly action: string;
  readonly recipients: readonly {
    readonly user: UserId;
    readonly name: string | null;
    readonly confirmedAt: number;
  }[];
  reserve(): boolean;
}

export interface QuestionnaireInvitationPort {
  writing(scope: ConnectionScope, guard: IntroductionGuard): Promise<WritePermission>;
  name(user: UserId): Promise<string | null>;
  sendInvitation(
    scope: ConnectionScope,
    sendId: number,
    guard: IntroductionGuard,
    prepare: () => QuestionnaireInvitationDispatch | null,
    confirm: (part: PublishedPart) => void,
  ): Promise<ResponseRateOutcome>;
}

export function createQuestionnaireInvitation(options: {
  readonly store: ReturnType<typeof greetingStore>;
  readonly questionnaire?: QuestionnaireInvitationSource;
  readonly port: QuestionnaireInvitationPort;
  readonly signal: AbortSignal;
  readonly limit: number;
}) {
  const { store, questionnaire, port, signal, limit } = options;
  return async (scope: ConnectionScope, id: number, active: () => boolean) => {
    const available = () => {
      if (!questionnaire || !active()) return null;
      const pending = store.prepareInvitation(scope, id, Date.now());
      if (!pending?.recipients.length) return null;
      try {
        const action = questionnaire.action(scope);
        if (!action?.trim()) return null;
        const recipients = pending.recipients.filter(
          ({ user }) => questionnaire.state(scope, user) === 'available',
        );
        return recipients.length ? { action, recipients, disclosure: pending.disclosure } : null;
      } catch {
        return null;
      }
    };
    const initial = available();
    let subjects: readonly UserId[] | undefined;
    let outcome: ResponseRateOutcome = 'unknown';
    const guard = { signal, isCurrent: active };
    const sendId = store.allocate();
    try {
      if (!initial || (await port.writing(scope, guard)) !== 'allowed' || !active()) return;
      const names = new Map(
        await Promise.all(
          initial.recipients.map(async ({ user }) => {
            const name = await port.name(user).catch(() => null);
            return [user, name] as const;
          }),
        ),
      );
      outcome = await port.sendInvitation(
        scope,
        sendId,
        guard,
        () => {
          const latest = available();
          if (!latest || latest.disclosure !== initial.disclosure) return null;
          return {
            action: latest.action,
            recipients: latest.recipients.map((recipient) => ({
              ...recipient,
              name: names.get(recipient.user) ?? null,
            })),
            reserve() {
              if (subjects) return false;
              const current = () =>
                active() && JSON.stringify(available()) === JSON.stringify(latest);
              const users = latest.recipients.map(({ user }) => user);
              if (!store.start(scope, id, sendId, Date.now(), limit, current, users)) return false;
              subjects = users;
              return true;
            },
          };
        },
        (part) => {
          if (subjects) store.confirm(scope, id, sendId, part, subjects, 'invitation');
        },
      );
    } catch {
      // Неизвестный исход сохраняется с исходным идентификатором отправки.
    } finally {
      if (active()) {
        if (subjects)
          store.settle(
            scope,
            id,
            sendId,
            outcome === 'failed' ? 'failed' : 'unknown',
            'invitation',
          );
        else store.skip(scope, id, 'invitation');
      }
    }
  };
}
