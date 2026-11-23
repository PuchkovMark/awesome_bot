import type { ConnectionScope, PublishedPart, UserId } from '../../contracts/index';
import type { IntroductionGuard, WritePermission } from '../chat-onboarding/ports';
import type { ResponseRateOutcome } from '../../storage/response-rate-store';
import type { greetingStore } from '../../storage/greeting-store';
import type { ScopedStorage } from '../../storage/scoped-types';
import type { addressPreferenceStore } from '../../storage/address-preference-store';
import { formatGreeting } from './text';

interface GreetingPort {
  writing(scope: ConnectionScope, guard: IntroductionGuard): Promise<WritePermission>;
  name(user: UserId): Promise<string | null>;
  send(
    scope: ConnectionScope,
    text: string,
    id: number,
    guard: IntroductionGuard & { beforeSend(): boolean },
    confirm: (part: PublishedPart) => void,
  ): Promise<ResponseRateOutcome>;
}

export function createGreetingService(options: {
  readonly store: ReturnType<typeof greetingStore>;
  readonly profiles: ScopedStorage['profileFacts'];
  readonly address: ReturnType<typeof addressPreferenceStore>;
  readonly scope: (value: Pick<ConnectionScope, 'chatId' | 'generation'>) => ConnectionScope;
  readonly scopeCurrent: (scope: ConnectionScope) => boolean;
  readonly signal: AbortSignal;
  readonly limit: number;
  readonly questionnaire?: (scope: ConnectionScope) => boolean;
  readonly rules?: (scope: ConnectionScope) => string | undefined;
  readonly port: GreetingPort;
}) {
  const { store, profiles, address, signal, port } = options;
  return {
    recover: store.recover,
    async due(): Promise<boolean> {
      if (signal.aborted) return false;
      const work = store.due(Date.now());
      if (!work) return false;
      let scope: ConnectionScope;
      try {
        scope = options.scope(work);
      } catch {
        return true;
      }
      const id = work.id;
      const active = () => !signal.aborted && options.scopeCurrent(scope);
      const first = store.prepare(scope, id, Date.now());
      if (!first || !active()) {
        if (active()) store.skip(scope, id);
        return true;
      }
      const data = JSON.stringify(first);
      const single = first.members.length === 1 ? first.members[0] : undefined;
      const profile = single && first.template ? profiles.read(scope, single.user) : undefined;
      const selected = single ? address.resolve(scope, single.user, Date.now(), true) : undefined;
      const rules = first.template ? options.rules?.(scope) : undefined;
      const questionnaire = options.questionnaire?.(scope) === true;
      const current = () =>
        active() &&
        JSON.stringify(store.prepare(scope, id, Date.now())) === data &&
        (!profile || profiles.isCurrent(scope, profile.reference)) &&
        (!single ||
          (selected
            ? address.current(scope, selected.reference)
            : address.resolve(scope, single.user, Date.now(), true) === undefined)) &&
        (!first.template || options.rules?.(scope) === rules) &&
        (options.questionnaire?.(scope) === true) === questionnaire;
      const permission = await port.writing(scope, { signal, isCurrent: current });
      if (permission !== 'allowed' || !current()) {
        if (active()) store.skip(scope, id);
        return true;
      }
      const name = selected?.text ?? (single ? await port.name(single.user) : null);
      const text = formatGreeting({
        count: first.members.length,
        questionnaire,
        returning: first.members.some((member) => member.returning),
        ...(name ? { name } : {}),
        ...(rules ? { rules } : {}),
        ...(first.template ? { template: first.template.text } : {}),
        ...(first.persona ? { persona: first.persona.text } : {}),
        ...(profile ? { facts: profile.facts } : {}),
      });
      const sendId = store.allocate();
      let started = false;
      let outcome: ResponseRateOutcome = 'unknown';
      try {
        if (current()) {
          outcome = await port.send(
            scope,
            text,
            sendId,
            {
              signal,
              isCurrent: active,
              beforeSend() {
                if (started) return false;
                started = store.start(scope, id, sendId, Date.now(), options.limit, current);
                return started;
              },
            },
            (part) => {
              if (part.text === text && part.replyToMessageId === undefined)
                store.confirm(
                  scope,
                  id,
                  sendId,
                  part,
                  first.members.map(({ user }) => user),
                );
            },
          );
        }
      } catch {
        // Без подтверждения не выполняем второй сетевой вызов.
      } finally {
        if (active()) {
          if (started) store.settle(scope, id, sendId, outcome === 'failed' ? 'failed' : 'unknown');
          else store.skip(scope, id);
        }
      }
      return true;
    },
  };
}
