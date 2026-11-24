import type { TokenReservation } from '../../storage/token-budget-store';
import { publicationRow } from '../message-router/publication';
import { initialTrace } from '../../storage/trace-store';
import type { TracePayload } from '../../storage/trace-types';
import { traceConfig } from '../response-tracing/config';
import { createTraceMetrics } from '../response-tracing/metrics';
import { StorageError } from '../../storage/errors';
import { randomUUID } from 'node:crypto';
import { queueBackend } from '../../storage/queue-registry';
import { noticeBackend } from '../../storage/notice-store';
import type { ResponsePublicationBudget } from '../../storage/queue-types';
import type { QueueWork } from '../../storage/queue-types';
import { QueueError } from './errors';
import { queueConfig } from './validation';
import type {
  ChatQueue,
  ChatQueueOptions,
  QueueOutcome,
  QueueStats,
  QueueCompletion,
} from './types';
import { chatLimits } from '../chat-limits/config';
import { responseRateConfig } from '../chat-limits/response-rate-config';
import type { LlmRecovery } from '../llm-recovery';
const outcomes = new Set<unknown>([
  'completed',
  'failed',
  'rate_limit',
  'interrupted',
  'expired',
  'message_missing',
  'deadline_exceeded',
]);
const HISTORY_MAINTENANCE_INTERVAL = 60_000;
interface Task {
  trace: TracePayload;
  startedAt: number;
  deadline: number;
  work: QueueWork;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  done: boolean;
  publishing: boolean;
  initiativeDenial?: import('../../storage/queue-types').InitiativeDenial;
}
function disclosureVersion(work: QueueWork) {
  return work.disclosureVersion === undefined ? {} : { disclosureVersion: work.disclosureVersion };
}
function safeFailure(error: unknown): QueueError {
  // Не читать произвольные свойства ошибок внедрённого обработчика.
  if (error instanceof QueueError) return error;
  if (error instanceof StorageError) {
    if (error.code === 'queue_lost_ownership') return new QueueError('lost_ownership');
    if (error.code === 'queue_owned') return new QueueError('owned');
    if (['invalid_input', 'stale_scope', 'uncertain_connection'].includes(error.code))
      return new QueueError('invalid_input');
  }
  return new QueueError('storage_failed');
}
export function createChatQueue(options: ChatQueueOptions): ChatQueue {
  if (!options || typeof options.handler !== 'function') throw new QueueError('invalid_input');
  const config = queueConfig(options.config);
  const limits =
    options.limits === undefined && !options.autonomousReplies
      ? undefined
      : chatLimits(options.limits);
  const responseRate =
    options.responseRate ?? (options.autonomousReplies ? responseRateConfig() : undefined);
  const notices = responseRate ? noticeBackend(options.storage) : undefined;
  const platform = options.platform;
  if (
    platform !== undefined &&
    (typeof platform !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(platform))
  )
    throw new QueueError('invalid_input');
  if (traceConfig(options.tracing).retentionDays * 86400000 <= config.handlerTimeoutMs)
    throw new QueueError('invalid_input');
  const traceSettings = traceConfig(options.tracing);
  const traceMetrics = createTraceMetrics(options.logger);
  const backend = queueBackend(options.storage);
  let initiativeQuota: ReturnType<typeof backend.autonomousQuota> | undefined;
  let recovery: LlmRecovery | undefined;
  const readMessage = options.storage.messages.get.bind(options.storage.messages);
  const handler = options.handler;
  const log = options.logger?.event.bind(options.logger);
  let phase: 'idle' | 'running' | 'stopping' | 'stopped' | 'failed' = 'idle';
  let token = '',
    renewAt = 0,
    scheduled = false,
    stopDeadline = Infinity;
  let tick: ReturnType<typeof setTimeout> | undefined,
    stopTimer: ReturnType<typeof setTimeout> | undefined;
  let historyCheckAt = 0,
    historyWake: ReturnType<typeof setImmediate> | undefined;
  let stopPromise: Promise<void> | undefined,
    resolveStop: (() => void) | undefined,
    rejectStop: ((error: QueueError) => void) | undefined;
  let failure: QueueError | undefined;
  const lifetime = new AbortController();
  const tasks = new Map<number, Task>();
  const counters = {
    depthQueued: 0,
    depthRunning: 0,
    waitCount: 0,
    waitTotalMs: 0,
    waitMaxMs: 0,
    rejected: 0,
    expired: 0,
    interrupted: 0,
  };
  const add = (a: number, b: number) => Math.min(Number.MAX_SAFE_INTEGER, a + b);
  function wait(ms: number) {
    counters.waitCount = add(counters.waitCount, 1);
    counters.waitTotalMs = add(counters.waitTotalMs, ms);
    counters.waitMaxMs = Math.max(counters.waitMaxMs, ms);
  }
  function emit() {
    Object.assign(counters, backend.depth(token));
    try {
      log?.({ event: 'queue_stats', window: 'run', ...counters }, 'info');
    } catch {
      /* Диагностика не меняет обработку. */
    }
  }
  function clearTimers() {
    clearImmediate(historyWake);
    historyWake = undefined;
    clearTimeout(tick);
    tick = undefined;
    clearTimeout(stopTimer);
    stopTimer = undefined;
  }
  function fault(error: unknown) {
    if (phase === 'failed' || phase === 'stopped') return;
    failure = safeFailure(error);
    phase = 'failed';
    lifetime.abort();
    clearTimers();
    for (const task of tasks.values()) {
      task.done = true;
      clearTimeout(task.timer);
      task.controller.abort();
    }
    tasks.clear();
    rejectStop?.(failure);
  }
  function completeStop() {
    if (phase !== 'stopping' || tasks.size) return;
    try {
      emit();
      backend.release(token);
      phase = 'stopped';
      clearTimers();
      resolveStop?.();
    } catch (error) {
      fault(error);
    }
  }
  function schedule() {
    if (scheduled || phase !== 'running') return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (phase === 'running') pump();
    });
  }
  function releaseTask(task: Task) {
    task.done = true;
    clearTimeout(task.timer);
    task.controller.abort();
    tasks.delete(task.work.id);
    if (phase === 'stopping') completeStop();
    else schedule();
  }
  function finish(task: Task, outcome: QueueOutcome, completion?: QueueCompletion) {
    if (task.done) return;
    if (task.publishing) {
      releaseTask(task);
      return;
    }
    const now = performance.now();
    if (outcome !== 'interrupted') {
      if (phase === 'stopping' && now >= stopDeadline && stopDeadline <= task.deadline)
        outcome = 'interrupted';
      else if (now >= task.deadline) outcome = 'deadline_exceeded';
    }
    if (outcome === 'interrupted' || now >= task.deadline) task.controller.abort();
    try {
      const actual = backend.valid(token, task.work) ? outcome : 'interrupted';
      const relevant = completion?.outcome === actual ? completion : undefined;
      const initiativeDenial =
        completion?.initiativeDenial ??
        task.initiativeDenial ??
        (task.work.route?.kind === 'initiative'
          ? backend.checkInitiativePublication(token, task.work)
          : undefined);
      const publicationKind = relevant?.preparationFailure ?? relevant?.result?.kind ?? actual;
      const canPublish =
        !!options.onSettled &&
        !initiativeDenial &&
        actual !== 'interrupted' &&
        actual !== 'expired' &&
        actual !== 'message_missing' &&
        phase === 'running' &&
        performance.now() < task.deadline;
      task.trace = {
        ...task.trace,
        publication: {
          rowId: publicationRow(task.work.route, { kind: publicationKind }),
          tableVersion: 1,
          reaction: 'silence',
          status: canPublish ? 'pending_checks' : 'suppressed',
          reason:
            initiativeDenial ?? (canPublish ? 'none' : options.onSettled ? 'guard' : 'no_port'),
        },
      };
      const committed = backend.finish(
        token,
        task.work,
        actual,
        {
          ...task.trace,
          preparationFailure: completion?.preparationFailure ?? task.trace.preparationFailure,
          resultKind: completion?.result?.kind ?? task.trace.resultKind,
          summary: completion?.result?.summary ?? task.trace.summary,
        },
        {
          processingMs: Math.max(0, Math.round(now - task.startedAt)),
          quotaDenied: relevant?.result?.kind === 'quota_exhausted',
        },
      );
      if (committed === 'interrupted') counters.interrupted = add(counters.interrupted, 1);
      emit();
      if (
        options.onSettled &&
        !initiativeDenial &&
        committed &&
        committed !== 'interrupted' &&
        committed !== 'expired' &&
        committed !== 'message_missing' &&
        phase === 'running' &&
        performance.now() < task.deadline
      ) {
        task.publishing = true;
        const isCurrent = () => {
          if (task.done || phase !== 'running' || performance.now() >= task.deadline) return false;
          try {
            return (
              (relevant?.toolResultsCurrent?.() ?? true) &&
              backend.publicationValid(token, task.work)
            );
          } catch {
            return false;
          }
        };
        const accepted =
          completion && committed === completion.outcome ? completion : { outcome: committed };
        void Promise.resolve()
          .then(() => {
            if (isCurrent())
              return options.onSettled!(
                {
                  jobId: task.work.id,
                  scope: task.work.scope,
                  messageId: task.work.messageId,
                  route: task.work.route,
                  signal: task.controller.signal,
                  isCurrent,
                  ...disclosureVersion(task.work),
                },
                accepted,
              );
          })
          .catch(() => {})
          .finally(() => {
            if (!task.done) releaseTask(task);
          });
      } else releaseTask(task);
    } catch (error) {
      task.controller.abort();
      fault(error);
    }
  }
  function launch(work: QueueWork) {
    wait(Math.max(0, Date.now() - work.receivedAt));
    const controller = new AbortController();
    const startedAt = performance.now();
    const task: Task = {
      trace: initialTrace(work.route),
      startedAt,
      deadline: startedAt + config.handlerTimeoutMs,
      work,
      controller,
      done: false,
      publishing: false,
      timer: setTimeout(() => finish(task, 'deadline_exceeded'), config.handlerTimeoutMs),
    };
    tasks.set(work.id, task);
    const running = () =>
      !task.done &&
      phase === 'running' &&
      !controller.signal.aborted &&
      performance.now() < task.deadline;
    const isCurrent = () => {
      if (!running()) return false;
      try {
        return backend.valid(token, work);
      } catch {
        return false;
      }
    };
    void Promise.resolve()
      .then(async () => {
        if (task.done) return;
        const message = await readMessage(work.scope, work.messageId);
        if (task.done) return;
        if (!message) {
          finish(task, 'message_missing');
          return;
        }
        if (!backend.valid(token, work)) {
          finish(task, 'interrupted');
          return;
        }
        if (work.route) {
          const settings = await options.storage.chats.get(work.scope);
          if (task.done) return;
          if (
            !settings?.enabled ||
            settings.responseMode === 'silent' ||
            !backend.valid(token, work)
          ) {
            finish(task, 'interrupted');
            return;
          }
        }
        if (work.route?.kind === 'initiative') {
          const initiativeDenial = backend.checkInitiative(token, work, limits, responseRate);
          if (initiativeDenial) {
            finish(task, 'failed', { outcome: 'failed', initiativeDenial });
            return;
          }
        }
        const outcome: unknown = await handler(
          Object.freeze({
            jobId: work.id,
            deadline: task.deadline,
            recordTrace: (update: Partial<TracePayload>) => {
              if (task.done || !backend.valid(token, work)) return;
              const next = { ...task.trace, ...update };
              if (backend.progress(token, work, next)) task.trace = next;
            },
            scope: work.scope,
            messageId: work.messageId,
            signal: controller.signal,
            route: work.route,
            ...disclosureVersion(work),
            ...(work.initiativeEvidenceId === undefined
              ? {}
              : { initiativeEvidenceId: work.initiativeEvidenceId }),
            isCurrent,
            recordMetric: (
              event: import('../../contracts/chat-metrics').JobMetricEvent,
              ordinal: number,
            ) => {
              if (!task.done) backend.recordMetric(token, work, event, ordinal);
            },
            ...(limits && work.route && work.route.kind !== 'initiative'
              ? { checkRequestQuota: () => backend.checkRequestQuota(token, work, limits) }
              : {}),
            ...((limits && work.route) ||
            responseRate ||
            options.tokenBudget ||
            backend.historyConfigured
              ? {
                  admitModelAttempt: (
                    allow: () => boolean,
                    contextIds?: readonly number[],
                    reservation?: TokenReservation,
                    finalBudget?: import('../../storage/token-budget-store').FinalBudget,
                  ) => {
                    const admission = backend.admitModelAttempt(
                      token,
                      work,
                      limits,
                      () => running() && allow() && running(),
                      Date.now,
                      contextIds,
                      responseRate,
                      reservation,
                      finalBudget,
                    );
                    if (admission === false && work.route?.kind === 'initiative' && !task.done) {
                      const denial = backend.checkInitiative(token, work, limits, responseRate);
                      if (denial) task.initiativeDenial = denial;
                    }
                    return admission;
                  },
                }
              : {}),
          }),
        );
        const completion: QueueCompletion =
          typeof outcome === 'object' &&
          outcome !== null &&
          outcomes.has((outcome as QueueCompletion).outcome)
            ? (outcome as QueueCompletion)
            : { outcome: outcomes.has(outcome) ? (outcome as QueueOutcome) : 'failed' };
        finish(task, completion.outcome, completion);
      })
      .catch(() => finish(task, 'failed'));
  }
  function pump() {
    if (phase !== 'running' && phase !== 'stopping') return;
    try {
      backend.check(token);
      if (performance.now() >= renewAt) {
        backend.renew(token, config.leaseMs);
        if (limits) backend.pruneQuotas(token, limits, platform);
        if (responseRate) backend.pruneResponseRate(token, responseRate);
        if (options.tokenBudget) backend.pruneTokenBudget(token);
        backend.pruneMetrics(token);
        renewAt = performance.now() + config.renewIntervalMs;
      }
      for (const task of [...tasks.values()])
        if (
          !(task.publishing
            ? backend.publicationValid(token, task.work)
            : backend.valid(token, task.work))
        )
          finish(task, 'interrupted');
      if (phase === 'running') {
        const expired = backend.expire(token);
        counters.expired = add(counters.expired, expired.length);
        expired.forEach(wait);
        if (options.autonomousReplies) backend.promoteQuestions(token, config, platform);
        while (tasks.size < config.maxConcurrentChats) {
          const work = backend.take(
            token,
            [...tasks.values()].map((t) => t.work.scope.chatId),
            platform,
          );
          if (!work) break;
          launch(work);
        }
        emit();
        if (
          backend.historyConfigured &&
          historyWake === undefined &&
          performance.now() >= historyCheckAt
        )
          maintainHistory();
      }
    } catch (error) {
      fault(error);
    }
  }
  function maintainHistory() {
    historyCheckAt = performance.now() + HISTORY_MAINTENANCE_INTERVAL;
    try {
      if (backend.pruneHistory(token)) {
        historyWake = setImmediate(() => {
          historyWake = undefined;
          historyCheckAt = 0;
          pump();
        });
        historyWake.unref();
      }
    } catch (error) {
      // A failed batch leaves the durable boundaries in force. Retry on the next pass.
      if (error instanceof StorageError && error.code === 'queue_lost_ownership') throw error;
    }
  }
  function armTick() {
    if (phase !== 'running' && phase !== 'stopping') return;
    tick = setTimeout(
      () => {
        tick = undefined;
        pump();
        armTick();
      },
      Math.max(1, Math.min(1000, config.renewIntervalMs)),
    );
    tick.unref();
  }
  const responseBudget: ResponsePublicationBudget | undefined =
    responseRate && notices
      ? {
          currentFlood(input) {
            if (phase !== 'running') return false;
            try {
              return backend.currentPublicationFlood(token, input);
            } catch {
              return false;
            }
          },
          start(input, isCurrent) {
            if (
              phase !== 'running' ||
              (platform !== undefined && !input.scope.chatId.startsWith(platform + ':'))
            )
              return { allowed: false, reason: 'guard' };
            try {
              return backend.startPublication(
                token,
                input,
                responseRate,
                notices,
                isCurrent,
                Date.now(),
                initiativeQuota,
              );
            } catch (error) {
              try {
                backend.check(token);
              } catch (fatal) {
                fault(fatal);
              }
              throw safeFailure(error);
            }
          },
          repeatInitiative(input) {
            backend.repeatInitiative(input);
          },
          confirmInitiative(input, receipt, text, replyToMessageId, isCurrent) {
            backend.confirmInitiative(
              token,
              input,
              notices,
              receipt,
              text,
              replyToMessageId,
              isCurrent,
            );
          },
          finish(input, outcome) {
            if (phase !== 'running' && phase !== 'stopping') return;
            try {
              backend.finishPublication(token, input, outcome);
            } catch (error) {
              try {
                backend.check(token);
              } catch (fatal) {
                fault(fatal);
              }
              throw safeFailure(error);
            }
          },
        }
      : undefined;
  function recoveryAction<T>(fn: (store: LlmRecovery) => T, unavailable: T): T {
    if (!recovery || (phase !== 'running' && phase !== 'stopping')) return unavailable;
    try {
      return fn(recovery);
    } catch (error) {
      fault(error);
      return unavailable;
    }
  }
  const llmRecovery: LlmRecovery = {
    availability: () =>
      phase === 'running' ? recoveryAction((store) => store.availability(), 'stopped') : 'stopped',
    begin: () => (phase === 'running' ? recoveryAction((store) => store.begin(), null) : null),
    finish: (permit, result) => recoveryAction((store) => store.finish(permit, result), undefined),
  };
  const service: ChatQueue = {
    ...(options.autonomousReplies ? { autonomousReplies: true } : {}),
    ...(options.llmRecovery ? { llmRecovery: Object.freeze(llmRecovery) } : {}),
    ...(responseBudget ? { responseBudget: Object.freeze(responseBudget) } : {}),
    signal: lifetime.signal,
    wakeHistoryMaintenance() {
      historyCheckAt = 0;
      schedule();
    },
    isRunning() {
      if (phase !== 'running') return false;
      try {
        backend.check(token);
        return true;
      } catch {
        return false;
      }
    },
    async start() {
      if (phase !== 'idle') throw new QueueError('stopped');
      token = randomUUID();
      try {
        counters.interrupted = backend.acquire(
          token,
          config.leaseMs,
          config.renewIntervalMs,
          traceSettings,
          traceMetrics.record,
          platform,
        );
      } catch (error) {
        throw safeFailure(error);
      }
      phase = 'running';
      if (options.llmRecovery) recovery = backend.llmRecovery(token, options.llmRecovery);
      if (options.autonomousReplies && limits)
        initiativeQuota = backend.autonomousQuota(token, limits, platform);
      renewAt = performance.now() + config.renewIntervalMs;
      pump();
      armTick();
      if (failure) throw failure;
    },
    async admitRouted(scope, message, decision, guard, serviceInput) {
      if (phase !== 'running') return { admission: { status: 'stopped' }, decision: null };
      if (platform !== undefined && !scope.chatId.startsWith(platform + ':'))
        throw new QueueError('invalid_input');
      try {
        const result = backend.admitRouted(
          token,
          scope,
          message,
          decision,
          config,
          guard,
          responseRate,
          options.autonomousReplies,
          serviceInput,
        );
        if (result.admission.status === 'queue_full') counters.rejected = add(counters.rejected, 1);
        emit();
        schedule();
        return result;
      } catch (error) {
        try {
          backend.check(token);
        } catch (fatal) {
          fault(fatal);
        }
        throw safeFailure(error);
      }
    },
    async admit(scope, message, decision) {
      if (phase !== 'running') return { status: 'stopped' as const };
      if (platform !== undefined && !scope.chatId.startsWith(platform + ':'))
        throw new QueueError('invalid_input');
      try {
        const expired = backend.expire(token);
        counters.expired = add(counters.expired, expired.length);
        expired.forEach(wait);
        const result = backend.admit(token, scope, message, decision, config);
        if (result.status === 'queue_full') counters.rejected = add(counters.rejected, 1);
        emit();
        schedule();
        return Object.freeze(result);
      } catch (error) {
        // Ошибка ввода/области не останавливает здоровую очередь; потеря владения обнаруживается отдельно.
        try {
          backend.check(token);
        } catch (fatal) {
          fault(fatal);
        }
        throw safeFailure(error);
      }
    },
    stop() {
      lifetime.abort();
      if (stopPromise) return stopPromise;
      if (phase === 'failed') return Promise.reject(failure);
      if (phase === 'idle' || phase === 'stopped') {
        phase = 'stopped';
        return Promise.resolve();
      }
      stopPromise = new Promise<void>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      phase = 'stopping';
      stopDeadline = performance.now() + config.stopTimeoutMs;
      stopTimer = setTimeout(() => {
        for (const task of [...tasks.values()]) finish(task, 'interrupted');
        completeStop();
      }, config.stopTimeoutMs);
      for (const task of [...tasks.values()]) if (task.publishing) releaseTask(task);
      completeStop();
      return stopPromise;
    },
    traceStats: traceMetrics.snapshot,
    stats(): QueueStats {
      if (phase === 'running' || phase === 'stopping') emit();
      return Object.freeze({ ...counters });
    },
  };
  return Object.freeze(service);
}
