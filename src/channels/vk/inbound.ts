import type { ChatId, ConnectionScope, EventHandler, IncomingMessage, MembershipEvent } from '../../contracts/index.js';
import type { createLifecycleService, createMessageRouter } from '../../core/index.js';
import { StorageError } from '../../storage/errors.js';
import { createVkSdkApi } from './api.js';
import type { VkInboundApi } from './api.js';
import { createVkLongPoll } from './long-poll.js';
import type { VkPollGap, VkPollTransport } from './long-poll.js';
import { normalizeVkIncoming, parseVkIncoming, vkChatId } from './normalize.js';

type Lifecycle = Pick<ReturnType<typeof createLifecycleService>,
  'current' | 'admissionScope' | 'isAdmissionCurrent' | 'activeChatIds' | 'verify' | 'recordConnectionSignal'>;
type Router = Pick<ReturnType<typeof createMessageRouter>, 'receive'>;
type Dispatch = (message: IncomingMessage, scope: ConnectionScope, isCurrent: () => boolean) => Promise<void>;
type MembershipHandler = (event: MembershipEvent) => Promise<void>;

export interface VkInboundOptions {
  readonly groupId: number;
  readonly token: string;
  readonly lifecycle: Lifecycle;
  readonly signal?: AbortSignal;
}

interface VkInboundDependencies {
  readonly api?: VkInboundApi;
  readonly transport?: VkPollTransport;
}

export function createVkInbound(options: VkInboundOptions, dependencies: VkInboundDependencies = {}) {
  const { groupId, token, lifecycle } = options;
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !token.trim()) {
    throw new TypeError('VK inbound: invalid configuration');
  }
  const api = dependencies.api ?? createVkSdkApi(groupId, token);
  const transport = dependencies.transport ?? createVkLongPoll({ api });
  const signal = options.signal ?? new AbortController().signal;
  const counters = {
    ignored: 0, invalid: 0, paused: 0, dispatched: 0, failed: 0,
    connectionChanges: 0, membershipDispatched: 0, duplicateSignals: 0, staleSignals: 0,
  };
  const gaps: Record<VkPollGap, number> = {
    startup: 0, lost_position: 0, renew_server: 0, invalid_response: 0, transport_error: 0,
  };
  const membershipObservations = new Map<ChatId, ConnectionScope>();
  let started = false;

  function current(chatId: ChatId): ConnectionScope | undefined {
    try {
      return lifecycle.current(chatId);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'stale_scope') return undefined;
      throw error;
    }
  }

  async function pause(chatId: ChatId): Promise<void> {
    for (;;) {
      if ((await lifecycle.verify(chatId, 'observation_lost')).status !== 'stale') return;
      try {
        if (!current(chatId)) return;
      } catch (error) {
        if (error instanceof StorageError && error.code === 'uncertain_connection') return;
        throw error;
      }
    }
  }

  function observeMembership(chatId: ChatId) {
    try {
      membershipObservations.set(chatId, lifecycle.admissionScope(chatId));
    } catch {
      membershipObservations.delete(chatId);
    }
  }

  async function run(dispatch: Dispatch, membership?: MembershipHandler): Promise<void> {
    if (started) throw new Error('VK inbound: already started');
    started = true;
    let subscription = Symbol();
    const tails = new Map<ChatId, Promise<void>>();
    const pending = new Set<Promise<void>>();
    let observing = true;

    async function deliverMembership(event: MembershipEvent, handler: MembershipHandler) {
      counters.membershipDispatched++;
      await handler(event);
    }

    function onUpdates(updates: readonly unknown[]) {
      for (const update of updates) {
        if (!observing || signal.aborted) return;
        const parsed = parseVkIncoming(update, groupId);
        if (parsed.kind === 'membership') {
          const { chatId, event } = parsed;
          if (!event) counters.invalid++;
          if (parsed.affectsConnection) {
            counters.connectionChanges++;
            try {
              const { status } = lifecycle.recordConnectionSignal(chatId, parsed.signalKey);
              if (status === 'stale') {
                counters.staleSignals++;
                continue;
              }
              if (status === 'duplicate') counters.duplicateSignals++;
              else tails.delete(chatId);
            } catch {
              counters.failed++;
              tails.delete(chatId);
              membershipObservations.delete(chatId);
              continue;
            }
          }
          if (event) {
            observeMembership(chatId);
            if (membership) {
              const task = deliverMembership(event, membership)
                .catch(() => { counters.failed++; }).finally(() => { pending.delete(task); });
              pending.add(task);
            }
          }
          continue;
        }
        if (parsed.kind !== 'message') {
          counters[parsed.kind]++;
          continue;
        }
        const message = parsed.message;
        const chatId = vkChatId(message.peerId);
        const receivedIn = subscription;
        let scope: ConnectionScope;
        try {
          scope = lifecycle.admissionScope(chatId);
        } catch (error) {
          if (error instanceof StorageError && error.code === 'stale_scope') {
            counters.paused++;
            void pause(chatId).catch(() => { counters.failed++; });
            continue;
          }
          if (error instanceof StorageError && error.code === 'uncertain_connection') {
            counters.paused++;
            continue;
          }
          counters.failed++;
          continue;
        }
        function isCurrent() {
          return !signal.aborted && receivedIn === subscription && lifecycle.isAdmissionCurrent(scope);
        }
        const task = (tails.get(chatId) ?? Promise.resolve()).then(async () => {
          if (!isCurrent()) {
            counters.paused++;
            return;
          }
          const enrichment = await api.enrich(message);
          if (!isCurrent()) {
            counters.paused++;
            return;
          }
          counters.dispatched++;
          await dispatch(normalizeVkIncoming(message, groupId, enrichment), scope, isCurrent);
        }).catch(() => { counters.failed++; }).finally(() => {
          pending.delete(task);
          if (tails.get(chatId) === task) tails.delete(chatId);
        });
        tails.set(chatId, task);
        pending.add(task);
      }
    }

    try {
      await transport.run({
        async onGap(reason) {
          gaps[reason]++;
          const next = Symbol();
          subscription = next;
          observing = false;
          tails.clear();
          membershipObservations.clear();
          await Promise.all(lifecycle.activeChatIds('vk').map(pause));
          if (subscription === next) observing = true;
        },
        onUpdates,
      }, signal);
    } finally {
      observing = false;
      subscription = Symbol();
      membershipObservations.clear();
      await Promise.all(pending);
    }
  }

  return Object.freeze({
    platform: 'vk' as const,
    start(handler: EventHandler) {
      return run(message => handler(message), handler);
    },
    /** Доверенная композиция сохраняет область подключения внутри входного пути. */
    startRouted(router: Router, membership?: MembershipHandler) {
      return run(async (message, scope, isCurrent) => { await router.receive(scope, message, undefined, isCurrent); }, membership);
    },
    hasMembershipObservation(chatId: ChatId): boolean {
      const scope = membershipObservations.get(chatId);
      if (signal.aborted || scope === undefined) return false;
      if (lifecycle.isAdmissionCurrent(scope)) return true;
      membershipObservations.delete(chatId);
      return false;
    },
    stats() {
      return Object.freeze({ ...counters, gaps: Object.freeze({ ...gaps }) });
    },
  });
}
