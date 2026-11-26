import type { ConnectionScope, PublishedPart, UserId } from '../../contracts/index';
import type { QuestionnaireRevision } from '../../contracts/questionnaire';
import type { greetingStore } from '../../storage/greeting-store';
import type { InvitationStage } from '../../storage/questionnaire-invitation-deliveries';
import type { ResponseRateOutcome } from '../../storage/response-rate-store';
import type { IntroductionGuard, WritePermission } from '../chat-onboarding/ports';

export interface QuestionnaireInvitationSource {
  revision(scope: ConnectionScope): QuestionnaireRevision | null;
  state(scope: ConnectionScope, user: UserId): 'available' | 'completed' | 'unavailable';
}

export interface QuestionnaireInvitationDispatch {
  readonly questions: string;
  readonly warningDelivered: boolean;
  readonly recipients: readonly {
    readonly user: UserId;
    readonly name: string | null;
    readonly confirmedAt: number;
  }[];
  reserve(stage: InvitationStage, text: string): boolean;
}

export interface QuestionnaireInvitationPort {
  writing(scope: ConnectionScope, guard: IntroductionGuard): Promise<WritePermission>;
  name(user: UserId): Promise<string | null>;
  sendInvitation(
    scope: ConnectionScope,
    sendId: number,
    guard: IntroductionGuard,
    prepare: () => QuestionnaireInvitationDispatch | null,
    received: (id: string) => void,
    confirm: (part: PublishedPart) => void,
  ): Promise<ResponseRateOutcome>;
  confirmInvitation(
    scope: ConnectionScope,
    receipt: string,
    guard: IntroductionGuard,
  ): Promise<PublishedPart | null>;
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
    const guard = { signal, isCurrent: active };
    const deliveries = store.invitations;
    const check = deliveries.check(scope, id, Date.now());
    if (check !== undefined) {
      if (check && active()) {
        try {
          const part = await port.confirmInvitation(scope, String(check.receipt), guard);
          if (part && active()) deliveries.confirm(scope, id, check.sendId, part, Date.now());
        } catch {
          // Следующая сверка использует ту же квитанцию.
        }
      }
      return;
    }
    const available = () => {
      if (!questionnaire || !active()) return null;
      const pending = store.prepareInvitation(scope, id, Date.now());
      if (!pending?.recipients.length) return null;
      try {
        const revision = pending.pinned ?? questionnaire.revision(scope);
        if (!revision?.questions.length) return null;
        const recipients = pending.recipients.filter(
          ({ user }) => questionnaire.state(scope, user) === 'available',
        );
        return recipients.length
          ? {
              revision,
              recipients,
              disclosure: pending.disclosure,
              warningDelivered: pending.pinned !== null,
            }
          : null;
      } catch {
        return null;
      }
    };
    const initial = available();
    let reserved = false;
    let outcome: ResponseRateOutcome = 'unknown';
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
            questions: latest.revision.questions.map(({ text }) => text).join('\n'),
            warningDelivered: latest.warningDelivered,
            recipients: latest.recipients.map((recipient) => ({
              ...recipient,
              name: names.get(recipient.user) ?? null,
            })),
            reserve(stage, text) {
              if (reserved) return false;
              const current = () =>
                active() && JSON.stringify(available()) === JSON.stringify(latest);
              reserved = deliveries.reserve(
                scope,
                id,
                sendId,
                stage,
                text,
                latest.revision,
                latest.disclosure,
                latest.recipients,
                Date.now(),
                limit,
                current,
              );
              return reserved;
            },
          };
        },
        (receipt) => {
          if (reserved) deliveries.received(scope, id, sendId, receipt);
        },
        (part) => {
          if (reserved && active()) deliveries.confirm(scope, id, sendId, part, Date.now());
        },
      );
    } catch {
      // Неизвестный исход сохраняется с исходным идентификатором отправки.
    } finally {
      if (active()) {
        if (reserved)
          deliveries.settle(
            scope,
            id,
            sendId,
            outcome === 'failed' ? 'failed' : 'unknown',
            Date.now(),
          );
        else store.skip(scope, id, 'invitation');
      }
    }
  };
}
