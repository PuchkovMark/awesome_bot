import { setTimeout as delay } from 'node:timers/promises';
import type {
  ChatId,
  ConnectionScope,
  EventHandler,
  IncomingMessage,
  MembershipEvent,
  RecoveryVersion,
  UserId,
} from '../../contracts/index';
import type { createLifecycleService, createMessageRouter } from '../../core/index';
import type { RoutedAdmissionGuard } from '../../storage/queue-types';
import { StorageError } from '../../storage/errors';
import { createVkSdkApi } from './api';
import type { VkInboundApi } from './api';
import type { ReceivedInput } from '../../core/chat-queue/types';
import { waitForVkRead } from './rate-limit';
import { createVkLongPoll } from './long-poll';
import type { VkPollGap, VkPollTransport } from './long-poll';
import {
  isVkGroupChat,
  normalizeVkIncoming,
  parseVkIncoming,
  vkChatId,
  type VkIncoming,
} from './normalize';

type Lifecycle = Pick<
  ReturnType<typeof createLifecycleService>,
  | 'current'
  | 'admissionScope'
  | 'isAdmissionCurrent'
  | 'activeChatIds'
  | 'verify'
  | 'recordConnectionSignal'
> &
  Partial<
    Pick<
      ReturnType<typeof createLifecycleService>,
      | 'recover'
      | 'recoveryCandidate'
      | 'recoveryCandidates'
      | 'wasRecovered'
      | 'rememberInput'
      | 'verifyReplacement'
    >
  >;
type Router = Pick<ReturnType<typeof createMessageRouter>, 'receive'> &
  Partial<Pick<ReturnType<typeof createMessageRouter>, 'registerInput'>>;
type Dispatch = (
  message: IncomingMessage,
  scope: ConnectionScope,
  isCurrent: () => boolean,
  disclosure?: RoutedAdmissionGuard,
  replyToOther?: boolean,
  isObserving?: () => boolean,
  received?: ReceivedInput,
) => Promise<void>;
type MembershipHandler = (event: MembershipEvent) => Promise<void>;
interface AdministrationInbound {
  readonly membership: (
    scope: ConnectionScope,
    userId: UserId,
    present: boolean,
    messageId: number,
    at: number,
  ) => void;
  readonly command: (message: VkIncoming, isCurrent: () => boolean) => Promise<void> | undefined;
}

export interface VkInboundOptions {
  readonly groupId: number;
  readonly token: string;
  readonly lifecycle: Lifecycle;
  readonly signal?: AbortSignal;
  readonly inputSignal?: AbortSignal;
  readonly capturePrivateDisclosure?: (scope: ConnectionScope) => RoutedAdmissionGuard | undefined;
  readonly notifyPrivate?: (
    scope: ConnectionScope,
    current: () => boolean,
    message: VkIncoming,
  ) => Promise<boolean>;
  readonly onReady?: () => void;
  readonly onDiagnostic?: (
    reason:
      | VkPollGap
      | 'previous_position'
      | 'new_position'
      | 'delivery_allowed'
      | 'delivery_unavailable',
  ) => void;
  readonly onMembershipChanged?: (
    scope: ConnectionScope,
    event: MembershipEvent,
    membershipMessageId?: string,
  ) => Promise<void>;
  readonly captureDisclosure?: (scope: ConnectionScope) => RoutedAdmissionGuard;
  readonly verifyFirstPrivate?: (message: VkIncoming) => boolean;
  readonly verifyDelivery?: (chatId: ChatId, current: () => boolean) => Promise<boolean>;
  readonly confirmReplacement?: (
    chatId: ChatId,
    departure: number,
    arrival: number,
    current: () => boolean,
  ) => Promise<boolean>;
  readonly enabled?: (scope: ConnectionScope) => boolean;
}

interface VkInboundDependencies {
  readonly api?: VkInboundApi;
  readonly transport?: VkPollTransport;
}

export function createVkInbound(
  options: VkInboundOptions,
  dependencies: VkInboundDependencies = {},
) {
  const { groupId, token, lifecycle } = options;
  if (!Number.isSafeInteger(groupId) || groupId <= 0 || !token.trim()) {
    throw new TypeError('VK inbound: invalid configuration');
  }
  const signal = options.signal ?? new AbortController().signal;
  const inputSignal = options.inputSignal ?? signal;
  const api = dependencies.api ?? createVkSdkApi(groupId, token, inputSignal);
  const transport = dependencies.transport ?? createVkLongPoll({ api });
  const counters = {
    ignored: 0,
    invalid: 0,
    paused: 0,
    dispatched: 0,
    failed: 0,
    connectionChanges: 0,
    membershipDispatched: 0,
    duplicateSignals: 0,
    staleSignals: 0,
  };
  const gaps: Record<VkPollGap, number> = {
    startup: 0,
    lost_position: 0,
    renew_server: 0,
    invalid_response: 0,
    transport_error: 0,
  };
  const membershipObservations = new Map<ChatId, ConnectionScope>();
  const groupChecks = new Map<
    ChatId,
    { version: RecoveryVersion; work: Promise<ConnectionScope | undefined> }
  >();
  let retryGroups: () => void = () => {};
  let started = false;

  function current(chatId: ChatId): ConnectionScope | undefined {
    try {
      return lifecycle.current(chatId);
    } catch (error) {
      if (error instanceof StorageError && error.code === 'stale_scope') return undefined;
      throw error;
    }
  }

  async function pause(
    chatId: ChatId,
    reason: 'startup' | 'observation_lost' | 'first_seen',
  ): Promise<void> {
    for (;;) {
      if ((await lifecycle.verify(chatId, reason)).status !== 'stale') return;
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

  function admission(chatId: ChatId) {
    try {
      return lifecycle.admissionScope(chatId);
    } catch (error) {
      if (error instanceof StorageError) {
        if (error.code === 'stale_scope') return undefined;
        if (error.code === 'uncertain_connection') return 'paused' as const;
      }
      throw error;
    }
  }

  async function openPrivate(message: VkIncoming, chatId: ChatId, observingEvent: () => boolean) {
    const allowed =
      message.authorId === message.peerId &&
      !message.hasReply &&
      !message.hasForwarded &&
      options.verifyFirstPrivate?.(message);
    if (!allowed) {
      await pause(chatId, 'first_seen');
      return;
    }
    let enrichment: Awaited<ReturnType<typeof api.enrich>> | undefined;
    const verified = await lifecycle.verify(chatId, undefined, {
      isCurrent: observingEvent,
      async prepare() {
        enrichment = await waitForVkRead(
          api.enrich(message, { signal: inputSignal, isCurrent: observingEvent }),
          inputSignal,
        );
        return enrichment.isBot === false && admission(chatId) === undefined;
      },
    });
    if (verified.scope && enrichment) return { scope: verified.scope, enrichment };
  }

  async function run(
    dispatch: Dispatch,
    membership?: MembershipHandler,
    administration?: AdministrationInbound,
    registerInput?: Router['registerInput'],
  ): Promise<void> {
    if (started) throw new Error('VK inbound: already started');
    started = true;
    let subscription = Symbol();
    const tails = new Map<ChatId, { tail: Promise<void>; openingScope?: ConnectionScope }>();
    const pending = new Set<Promise<unknown>>();
    let observing = true;
    let drainFailed = false;
    let available = false;
    const retryAt = new Map<ChatId, number>();
    function recoverGroup(expected: RecoveryVersion, current: () => boolean) {
      const chatId = expected.chatId;
      const existing = groupChecks.get(chatId);
      if (
        existing &&
        existing.version.generation === expected.generation &&
        existing.version.revision === expected.revision &&
        existing.version.controlRevision === expected.controlRevision
      )
        return existing.work;
      const work = (async () => {
        if (!options.verifyDelivery || !lifecycle.recover) return;
        const cooldown = (retryAt.get(chatId) ?? 0) - Date.now();
        if (cooldown > 0) {
          try {
            await delay(Math.min(cooldown, 1_000), undefined, { signal: inputSignal });
          } catch {
            return;
          }
          if (!current()) return;
        }
        const recovered = await lifecycle.recover(
          expected,
          true,
          () => options.verifyDelivery!(chatId, current),
          current,
        );
        if (current()) {
          options.onDiagnostic?.(recovered ? 'delivery_allowed' : 'delivery_unavailable');
          if (recovered) retryAt.delete(chatId);
          else retryAt.set(chatId, Date.now() + 30_000);
        }
        return recovered;
      })().finally(() => {
        if (groupChecks.get(chatId)?.work === work) groupChecks.delete(chatId);
      });
      groupChecks.set(chatId, { version: expected, work });
      return work;
    }
    retryGroups = () => {
      if (!available || signal.aborted || !lifecycle.recoveryCandidates || !options.verifyDelivery)
        return;
      const epoch = subscription;
      const valid = () => available && !signal.aborted && subscription === epoch;
      for (const chatId of lifecycle.recoveryCandidates('vk')) {
        if (
          !isVkGroupChat(Number(chatId.slice(3))) ||
          groupChecks.has(chatId) ||
          (retryAt.get(chatId) ?? 0) > Date.now()
        )
          continue;
        const expected = lifecycle.recoveryCandidate?.(chatId);
        if (!expected) continue;
        const work = recoverGroup(expected, valid)
          .catch(() => {
            counters.failed++;
          })
          .finally(() => pending.delete(work));
        pending.add(work);
      }
    };

    async function deliverMembership(event: MembershipEvent, handler: MembershipHandler) {
      counters.membershipDispatched++;
      await handler(event);
    }

    function onUpdates(updates: readonly unknown[]) {
      const firstPage = !available;
      available = true;
      const pageWork: Promise<unknown>[] = [];
      let complete = true;
      function failed() {
        complete = false;
        counters.failed++;
      }
      function track(work: Promise<unknown>) {
        pageWork.push(work);
        pending.add(work);
      }
      for (const update of updates) {
        if (!observing || signal.aborted) break;
        const parsed = parseVkIncoming(update, groupId);
        if (parsed.kind === 'membership') {
          const { chatId, event } = parsed;
          if (!event) counters.invalid++;
          if (parsed.affectsConnection) {
            counters.connectionChanges++;
            try {
              const actor = event?.actorId;
              const invitation =
                administration &&
                event?.change === 'invited' &&
                actor &&
                /^vk:[1-9]\d*$/u.test(actor) &&
                parsed.signalKey
                  ? {
                      actorId: actor,
                      messageId: Number(parsed.signalKey),
                      timestamp: event.timestamp,
                    }
                  : undefined;
              const left = event?.change === 'left' || event?.change === 'removed';
              const { status } = lifecycle.recordConnectionSignal(
                chatId,
                parsed.signalKey,
                invitation,
                left && parsed.signalKey ? Number(parsed.signalKey) : undefined,
              );
              if (status === 'stale') {
                counters.staleSignals++;
                continue;
              }
              if (status === 'duplicate') counters.duplicateSignals++;
              else tails.delete(chatId);
              if (
                event?.change === 'invited' &&
                parsed.signalKey &&
                options.confirmReplacement &&
                lifecycle.verifyReplacement
              ) {
                const seen = subscription;
                const current = () => !inputSignal.aborted && seen === subscription;
                const arrival = Number(parsed.signalKey);
                const work = lifecycle
                  .verifyReplacement(
                    chatId,
                    arrival,
                    (departure) => options.confirmReplacement!(chatId, departure, arrival, current),
                    current,
                  )
                  .catch(failed)
                  .finally(() => pending.delete(work));
                track(work);
              }
            } catch {
              failed();
              tails.delete(chatId);
              membershipObservations.delete(chatId);
              continue;
            }
          }
          if (event) {
            const subject = event.subjectId;
            if (
              administration &&
              !parsed.affectsConnection &&
              subject &&
              /^vk:[1-9]\d*$/u.test(subject) &&
              parsed.signalKey &&
              event.change !== 'unknown'
            ) {
              try {
                administration.membership(
                  lifecycle.admissionScope(chatId),
                  subject,
                  event.change === 'joined' || event.change === 'invited',
                  Number(parsed.signalKey),
                  event.timestamp,
                );
              } catch (error) {
                if (!(
                  error instanceof StorageError &&
                  (error.code === 'uncertain_connection' || error.code === 'stale_scope')
                ))
                  failed();
              }
            }
            observeMembership(chatId);
            const scope = membershipObservations.get(chatId);
            if (
              scope &&
              options.onMembershipChanged &&
              !parsed.affectsConnection &&
              (subject === null || /^vk:[1-9]\d*$/u.test(subject))
            ) {
              const task = options
                .onMembershipChanged(scope, event, parsed.signalKey)
                .catch(() => {
                  failed();
                })
                .finally(() => pending.delete(task));
              track(task);
            }
            if (membership) {
              const task = deliverMembership(event, membership)
                .catch(() => {
                  failed();
                })
                .finally(() => {
                  pending.delete(task);
                });
              track(task);
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
        const command = administration?.command(
          message,
          () => !signal.aborted && receivedIn === subscription,
        );
        if (command) {
          const work = command
            .catch(() => {
              failed();
            })
            .finally(() => {
              pending.delete(work);
            });
          track(work);
          continue;
        }
        let receivedScope: ReturnType<typeof admission>;
        try {
          receivedScope = admission(chatId);
        } catch {
          failed();
          continue;
        }
        const recovery =
          receivedScope === 'paused' && options.verifyDelivery
            ? lifecycle.recoveryCandidate?.(chatId)
            : undefined;
        if (receivedScope === 'paused' && !recovery) {
          counters.paused++;
          continue;
        }
        if (receivedScope === 'paused') receivedScope = undefined;
        if (
          !receivedScope &&
          !recovery &&
          (!options.verifyFirstPrivate || message.peerId < 0 || isVkGroupChat(message.peerId))
        ) {
          counters.paused++;
          const work = pause(chatId, 'first_seen')
            .catch(failed)
            .finally(() => pending.delete(work));
          track(work);
          continue;
        }
        const observingEvent = () => !inputSignal.aborted && receivedIn === subscription;
        const grouped = isVkGroupChat(message.peerId);
        if (receivedScope && options.enabled?.(receivedScope) === false) {
          counters.paused++;
          continue;
        }
        if (grouped && receivedScope) lifecycle.rememberInput?.(receivedScope, message.cmid);
        const disclosure =
          receivedScope && grouped ? options.captureDisclosure?.(receivedScope) : undefined;
        if (disclosure && !disclosure().journal) {
          counters.paused++;
          continue;
        }
        const received = registerInput?.(chatId, receivedScope, observingEvent);
        if (registerInput && !received) {
          counters.paused++;
          continue;
        }
        const inputCurrent = () => observingEvent() && (received?.isCurrent() ?? true);
        const batch = tails.get(chatId) ?? { tail: Promise.resolve() };
        const task = batch.tail
          .then(async () => {
            let prior = receivedScope ?? batch.openingScope;
            let verifiedAuthor: Awaited<ReturnType<typeof api.enrich>> | undefined;
            if (!prior && recovery && inputCurrent()) {
              if (grouped) prior = await recoverGroup(recovery, inputCurrent);
              else if (message.authorId === message.peerId && message.authorId > 0) {
                verifiedAuthor = await waitForVkRead(
                  api.enrich(message, { signal: inputSignal, isCurrent: inputCurrent }),
                  inputSignal,
                );
                if (verifiedAuthor.isBot === false && inputCurrent()) {
                  prior = await lifecycle.recover?.(
                    recovery,
                    false,
                    () => options.verifyDelivery!(chatId, inputCurrent),
                    inputCurrent,
                  );
                  options.onDiagnostic?.(prior ? 'delivery_allowed' : 'delivery_unavailable');
                }
              }
              if (prior) batch.openingScope = prior;
            }
            const opened =
              !recovery && prior === undefined && inputCurrent() && admission(chatId) === undefined
                ? await openPrivate(message, chatId, inputCurrent)
                : undefined;
            if (opened) batch.openingScope = opened.scope;
            const admittedScope = prior ?? opened?.scope;
            if (!admittedScope) {
              counters.paused++;
              return;
            }
            if (grouped && !receivedScope) lifecycle.rememberInput?.(admittedScope, message.cmid);
            const isCurrent = () =>
              inputCurrent() &&
              lifecycle.isAdmissionCurrent(admittedScope) &&
              options.enabled?.(admittedScope) !== false;
            if (!isCurrent()) {
              counters.paused++;
              return;
            }
            const enrichment =
              verifiedAuthor ??
              opened?.enrichment ??
              (await waitForVkRead(
                api.enrich(message, { signal: inputSignal, isCurrent }),
                inputSignal,
              ));
            if (!isCurrent()) {
              counters.paused++;
              return;
            }
            if (
              enrichment.isBot === false &&
              message.authorId === message.peerId &&
              !isVkGroupChat(message.peerId) &&
              options.notifyPrivate &&
              !(await options.notifyPrivate(admittedScope, isCurrent, message))
            )
              return;
            if (!isCurrent()) {
              counters.paused++;
              return;
            }
            counters.dispatched++;
            const normalized = normalizeVkIncoming(message, groupId, enrichment);
            await dispatch(
              normalized,
              admittedScope,
              isCurrent,
              disclosure ??
                (normalized.isGroupChat
                  ? options.captureDisclosure?.(admittedScope)
                  : options.capturePrivateDisclosure?.(admittedScope)),
              normalized.replyAddress === 'other' || normalized.replyAddress === 'unknown',
              inputCurrent,
              received,
            );
          })
          .catch(() => {
            failed();
            if (signal.aborted && !inputSignal.aborted) drainFailed = true;
          })
          .finally(() => {
            pending.delete(task);
            if (tails.get(chatId)?.tail === task) tails.delete(chatId);
            received?.complete();
          });
        batch.tail = task;
        tails.set(chatId, batch);
        track(task);
      }
      if (firstPage) retryGroups();
      return Promise.all(pageWork).then(() => complete);
    }

    let graceful = false;
    try {
      await transport.run(
        {
          ...(options.onReady ? { onReady: options.onReady } : {}),
          ...(options.onDiagnostic ? { onResume: options.onDiagnostic } : {}),
          async onGap(reason) {
            gaps[reason]++;
            options.onDiagnostic?.(reason);
            if (reason === 'transport_error' || reason === 'invalid_response') return;
            available = false;
            groupChecks.clear();
            retryAt.clear();
            const next = Symbol();
            subscription = next;
            observing = false;
            tails.clear();
            membershipObservations.clear();
            if (signal.aborted) return;
            const cause = reason === 'startup' ? 'startup' : 'observation_lost';
            await Promise.all(lifecycle.activeChatIds('vk').map((chatId) => pause(chatId, cause)));
            if (subscription === next) observing = true;
          },
          onUpdates,
        },
        signal,
      );
      graceful = signal.aborted && !inputSignal.aborted;
    } catch (error) {
      if (
        !signal.aborted ||
        !(error === signal.reason || (error instanceof Error && error.name === 'AbortError'))
      )
        throw error;
      graceful = !inputSignal.aborted;
    } finally {
      available = false;
      retryGroups = () => {};
      observing = false;
      if (!graceful) subscription = Symbol();
      membershipObservations.clear();
      await Promise.all(pending);
      subscription = Symbol();
    }
    if (graceful && drainFailed) throw new Error('VK inbound: input drain failed');
  }

  return Object.freeze({
    platform: 'vk' as const,
    retryGroups: () => retryGroups(),
    start(handler: EventHandler) {
      return run((message) => handler(message), handler);
    },
    /** Доверенная композиция сохраняет область подключения внутри входного пути. */
    startRouted(
      router: Router,
      membership?: MembershipHandler,
      administration?: AdministrationInbound,
    ) {
      return run(
        async (message, scope, isCurrent, disclosure, replyToOther, isObserving, received) => {
          await router.receive(
            scope,
            message,
            undefined,
            isCurrent,
            disclosure,
            replyToOther,
            isObserving,
            received,
          );
        },
        membership,
        administration,
        router.registerInput?.bind(router),
      );
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
