import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope } from '../../contracts/index';
import {
  disclosureStore,
  type DisclosureGate,
  type DisclosurePublication,
  type DisclosureReason,
} from '../../storage/chat-disclosure-store';
import type { Storage } from '../../storage/index';
import type { createLifecycleService } from '../lifecycle/service';
import { introductionText } from './introduction-text';
import type { IntroductionGuard, IntroductionPort } from './ports';

export function createChatOnboarding(options: {
  storage: Storage;
  lifecycle: ReturnType<typeof createLifecycleService>;
  port: IntroductionPort;
  signal: AbortSignal;
  groups: () => readonly ChatId[];
  provider: string;
  describeRights: (administration: boolean) => string;
  intervalMs?: number;
  replayWindowMs?: number;
}) {
  const store = disclosureStore(options.storage);
  const recoveringPrivate = new Set<number>();
  const closed: DisclosureGate = { journal: false, version: null, provider: null };
  function gate(scope: ConnectionScope) {
    try {
      const result = store.gate(scope);
      return result.provider === options.provider ? result : { ...result, version: null };
    } catch {
      return closed;
    }
  }

  function capture(scope: ConnectionScope) {
    const received = gate(scope);
    return () => {
      const current = gate(scope);
      return {
        journal: received.journal && current.journal,
        respond: received.version !== null && received.version === current.version,
        version: received.version,
      };
    };
  }

  async function send(
    scope: ConnectionScope,
    row: DisclosurePublication,
    target: 'chat' | 'owner',
    text: string,
    guard: IntroductionGuard,
    reason: DisclosureReason,
  ) {
    if (!guard.isCurrent()) return;
    const claim = store.claim(scope, row.id, text, Date.now(), options.replayWindowMs);
    if (!claim) return;
    const outcome = await options.port
      .publish(scope, target, claim.text!, claim.sendId!, guard, claim.replayUntil)
      .catch(() => ({ kind: 'unknown' as const }));
    try {
      if (outcome.kind === 'delivered')
        store.finish(scope, claim, 'delivered', Date.now(), null, outcome.receipt);
      else if (outcome.kind === 'failed')
        store.finish(scope, claim, 'pending', Date.now(), reason, null);
      else store.finish(scope, claim, 'unknown', Date.now(), 'unconfirmed', null);
    } catch {
      /* Если область менялась во время отправки, запись будет сверена заново. */
    }
  }

  async function reconcile(chatId: ChatId) {
    const current = store.latest();
    if (!current || current.provider !== options.provider || options.signal.aborted) return;
    const scope = options.lifecycle.admissionScope(chatId);
    const { settings } = await options.storage.chats.create(scope, {
      responseMode: 'normal',
      enabled: true,
      createdAt: Date.now(),
    });
    if (!settings.enabled) return;
    const isCurrent = () => !options.signal.aborted && options.lifecycle.isAdmissionCurrent(scope);
    const guard: IntroductionGuard = {
      signal: options.signal,
      isCurrent,
      async allow() {
        return isCurrent() && (await options.storage.chats.get(scope))?.enabled === true;
      },
    };
    if (!isCurrent()) return;
    store.recover(scope);
    const introduction = store.ensure(scope, 'introduction', current.version);
    const publications = store.publications(scope);
    const warnings = publications.find((row) => row.kind === 'owner');
    const updates = publications.filter((row) => row.kind === 'update' && row.state === 'pending');
    for (const row of updates) {
      if (store.version(row.version)?.requiredVersion !== current.requiredVersion)
        store.cancel(scope, row.id, 'stale_version');
    }
    const candidate =
      introduction.state === 'delivered'
        ? updates.find(
            (row) => store.version(row.version)?.requiredVersion === current.requiredVersion,
          )
        : introduction;
    if (!candidate && warnings?.state !== 'pending') return;
    const rights = await options.port.writing(scope, 'chat', guard);
    if (!isCurrent()) return;
    if (rights === 'allowed') {
      if (warnings?.state === 'pending') store.cancel(scope, warnings.id, 'rights');
      if (
        !candidate ||
        (candidate.state !== 'pending' &&
          !(
            candidate.state === 'unknown' &&
            candidate.kind === 'introduction' &&
            options.replayWindowMs
          ))
      )
        return;
      const selected = store.version(candidate.version);
      if (!selected || selected.requiredVersion !== current.requiredVersion) return;
      const text =
        candidate.text ??
        introductionText(
          selected,
          settings.timezone,
          options.describeRights(await options.port.hasAdministration(scope, guard)),
          candidate.kind === 'update',
        );
      const publicationGuard = {
        ...guard,
        isCurrent: () =>
          isCurrent() && store.latest()?.requiredVersion === selected.requiredVersion,
      };
      await send(scope, candidate, 'chat', text, publicationGuard, 'unavailable');
      return;
    }
    if (rights !== 'denied' || introduction.state === 'delivered') return;
    store.wait(scope, introduction.id, 'rights');
    const notification = store.ensure(scope, 'owner', current.version);
    if (notification.state !== 'pending') return;
    const ownerRights = await options.port.writing(scope, 'owner', guard);
    if (!isCurrent()) return;
    if (ownerRights !== 'allowed') {
      store.wait(scope, notification.id, ownerRights === 'denied' ? 'owner_closed' : 'unavailable');
      return;
    }
    const fresh = await options.port.writing(scope, 'chat', guard);
    if (!isCurrent()) return;
    if (fresh === 'allowed') store.cancel(scope, notification.id, 'rights');
    if (fresh === 'denied')
      await send(
        scope,
        notification,
        'owner',
        `Пенёк ждёт права отправки в беседе ${chatId}. До публикации вступления общение приостановлено.`,
        guard,
        'unavailable',
      );
  }

  return {
    gate,
    capture,
    privatePending(scope: ConnectionScope) {
      const latest = store.latest();
      return Boolean(latest?.profileNotice && gate(scope).version === null);
    },
    configuredForProfiles() {
      return Boolean(store.latest()?.profileNotice);
    },
    async notifyPrivate(scope: ConnectionScope, current: () => boolean) {
      const latest = store.latest();
      if (!latest?.profileNotice || latest.provider !== options.provider) return;
      const guard = {
        signal: options.signal,
        isCurrent: () =>
          current() &&
          !options.signal.aborted &&
          options.lifecycle.isAdmissionCurrent(scope) &&
          store.latest()?.requiredVersion === latest.requiredVersion,
      };
      if (!guard.isCurrent()) return;
      const { settings } = await options.storage.chats.create(scope, {
        responseMode: 'normal',
        enabled: true,
        createdAt: Date.now(),
      });
      if (!settings.enabled || !guard.isCurrent()) return;
      if (!recoveringPrivate.has(scope.generation)) {
        store.recover(scope);
        recoveringPrivate.add(scope.generation);
      }
      const intro = store.ensure(scope, 'introduction', latest.version);
      const row =
        intro.version === latest.version ? intro : store.ensure(scope, 'update', latest.version);
      const text = [
        latest.profileNotice,
        `Провайдер: ${latest.provider}. Подробности: ${latest.detailsUrl}`,
      ].join('\n');
      await send(scope, row, 'chat', text, guard, 'unavailable');
    },
    async run() {
      while (!options.signal.aborted) {
        for (const chatId of options.groups()) {
          try {
            await reconcile(chatId);
          } catch {
            /* Состояние будет проверено при следующей сверке. */
          }
        }
        try {
          await delay(options.intervalMs ?? 2000, undefined, { signal: options.signal });
        } catch {
          return;
        }
      }
    },
  };
}
