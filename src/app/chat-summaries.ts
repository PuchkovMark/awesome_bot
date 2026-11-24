import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope, PublishedPart } from '../contracts/index';
import type { LlmClient } from '../llm/types';
import { createLlmSessionId } from '../llm/session';
import { estimateRequestInput } from '../core/context/budget';
import { createAttemptSummary } from '../core/agent-loop/summary';
import type { QueueCompletion, QueueHandlerInput } from '../core/chat-queue/types';
import type { PublicationPort } from '../core/message-router/publication-service';
import type { Storage } from '../storage/index';
import { chatSummaryStore } from '../storage/chat-summary-store';
import { tokenBudgetStore } from '../storage/token-budget-store';
import { lifecycleBackend } from '../storage/lifecycle-store';
import { noticeBackend } from '../storage/notice-store';
import { summaryEngine, type SummaryRun } from '../core/chat-summaries/worker';
import { SummaryFailure } from '../core/chat-summaries/compress';
import { localDay } from '../core/chat-summaries/calendar';
import { recap, recapPeriod } from '../core/chat-summaries/recap';
import type { PreparedSummaries } from '../core/context/summaries';
import { scheduleLlmCall, type LlmAdmission, type SendLlmCall } from '../core/llm-admission';
import { measureModelCall } from '../core/model-measurement';

export function applicationSummaries(options: {
  storage: Storage;
  client: LlmClient;
  llmAdmission?: LlmAdmission;
  model: string;
  sessionSecret: string;
  intervalMs: number;
  fragmentSize: number;
  modelContext: number;
  inputBudget: number;
  signal: AbortSignal;
  port: PublicationPort;
  platform: string;
  group: (id: ChatId) => boolean;
  disclosure: (scope: ConnectionScope) => number | null;
  backgroundReady: () => boolean;
}) {
  const { storage, signal } = options;
  const life = lifecycleBackend(storage),
    store = chatSummaryStore(storage),
    budgets = tokenBudgetStore(storage);
  const engine = summaryEngine(store, options.fragmentSize);
  const session = createLlmSessionId('summary:' + options.sessionSecret);
  function enabled(scope: ConnectionScope) {
    return life.transaction(
      scope,
      (db) =>
        db.prepare('SELECT enabled FROM chats WHERE chat_id=?').pluck().get(scope.chatId) === 1,
    );
  }
  function buildRun(
    scope: ConnectionScope,
    cutoff: number,
    work?: QueueHandlerInput,
    usage = createAttemptSummary(),
    firstDeadline?: () => number | undefined,
  ): SummaryRun {
    const abort = work?.signal ?? signal;
    let step = 0;
    const version = work?.disclosureVersion ?? options.disclosure(scope);
    const current = () => {
      try {
        return (
          !abort.aborted &&
          enabled(scope) &&
          version !== null &&
          options.disclosure(scope) === version &&
          (!work || work.isCurrent())
        );
      } catch {
        return false;
      }
    };
    return {
      scope,
      cutoff,
      current,
      ...(!work ? { canStart: options.backgroundReady } : {}),
      compression: {
        sessionId: session(scope),
        signal: abort,
        outputLimit: 512,
        inputLimit: Math.min(8000, options.modelContext - 512),
        async invoke(request, sourceCurrent) {
          const allowed = () =>
            current() &&
            (sourceCurrent?.() ?? true) &&
            (work !== undefined || options.backgroundReady());
          const perform = (send: SendLlmCall) => {
            const attempt = {
              key: 'summary:' + randomUUID(),
              purpose: work ? ('direct' as const) : ('summary' as const),
              input: estimateRequestInput(request),
              output: request.maxOutputTokens,
            };
            const admission = work
              ? work.admitModelAttempt?.(allowed, [], attempt)
              : budgets.reserve(scope, options.group(scope.chatId), attempt, Date.now());
            if (admission === 'quota_exhausted') throw new SummaryFailure('quota');
            if (!admission || admission === 'context_stale') throw new SummaryFailure('cancelled');
            if (typeof admission === 'string') throw new SummaryFailure('limit');
            const meter =
              typeof admission === 'object' ? admission : budgets.meter(scope, attempt.key);
            return send(async () => {
              usage.beginAttempt();
              work?.recordTrace({
                model: { name: options.model, invoked: 'possible' },
                summary: usage.snapshot(0),
              });
              const response = await measureModelCall(
                meter,
                () => options.client.complete(request),
                { executor: 'main', step: step++ },
              ).catch(() => {
                throw new SummaryFailure(abort.aborted ? 'cancelled' : 'unavailable');
              });
              if ('usage' in response) {
                usage.recordUsage(response.usage);
                if (typeof admission === 'object') admission.recordUsage(response.usage);
                else budgets.reconcile(scope, attempt.key, response.usage);
              }
              return response;
            }, meter.cancelBeforeSend);
          };
          const deadline = work?.deadline;
          const waitDeadline = firstDeadline?.();
          const scheduled = await scheduleLlmCall(
            options.llmAdmission,
            {
              signal: abort,
              current: allowed,
              ...(deadline === undefined ? {} : { deadline }),
              ...(waitDeadline === undefined ? {} : { waitDeadline }),
              ...(work ? { jobSignal: work.signal } : {}),
            },
            perform,
            work ? 'direct' : 'background',
          );
          if (scheduled.kind === 'ready') return scheduled.value;
          throw new SummaryFailure(scheduled.kind === 'background_busy' ? 'busy' : scheduled.kind);
        },
      },
    };
  }
  async function tick() {
    for (const id of life.activeChatIds(options.platform)) {
      if (signal.aborted || !options.backgroundReady()) return;
      try {
        const scope = life.current(id, true);
        if (!enabled(scope) || options.disclosure(scope) === null) continue;
        const settings = await storage.contextState.settings(scope);
        const bounds = store.bounds(scope);
        if (settings && bounds.first !== null && bounds.cutoff !== null)
          await engine.maintain(
            buildRun(scope, bounds.cutoff),
            bounds.first,
            Date.now(),
            settings.timezone,
          );
      } catch (error) {
        if (signal.aborted) return;
        if (
          !(error instanceof SummaryFailure) &&
          !['stale_scope', 'uncertain_connection'].includes((error as { code: string }).code)
        )
          throw error;
      }
    }
  }
  async function notify(work: QueueHandlerInput, source: string, current: () => boolean) {
    const { scope } = work;
    const guard = { signal: work.signal, isCurrent: current, allow: async () => current() };
    if (
      !current() ||
      !(await options.port.canReply(scope, work.signal, source, guard)) ||
      !current() ||
      !store.reserveNotice(scope, work.messageId)
    )
      return;
    const text = 'собираю, минутку';
    let confirmed = false;
    const confirmPart = (part: PublishedPart) => {
      if (confirmed || !current()) return;
      life.transaction(scope, (db) => {
        noticeBackend(storage).recordAnswer(scope, part, part.text, source, current);
        db.prepare(
          "UPDATE messages SET purpose='service_notice' WHERE chat_id=? AND platform_message_id=? AND role='assistant'",
        ).run(scope.chatId, part.messageId);
        store.confirmNotice(scope, work.messageId);
      });
      confirmed = true;
    };
    const result = await options.port
      .publish({
        ...guard,
        scope,
        kind: 'notice',
        text,
        replyToMessageId: source,
        beforeSend: current,
        confirmPart,
      })
      .catch(() => null);
    if (result?.kind === 'delivered' && 'receipt' in result)
      confirmPart({ ...result.receipt, text, replyToMessageId: source });
  }
  return {
    async run() {
      while (!signal.aborted) {
        await tick();
        await delay(options.intervalMs, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
    context(
      scope: ConnectionScope,
      cutoff: number,
      timezone: string,
      now: number,
    ): PreparedSummaries | undefined {
      if (!store.hasComposites(scope)) return;
      const today = localDay(now, timezone);
      const periods = [1, 2, 3].map((n) => ({
        level: 'day' as const,
        period: localDay(now, timezone, -n),
      }));
      const choices = [
        ...periods,
        {
          level: 'rolling' as const,
          period: { ...today, from: localDay(now, timezone, -7).from, to: today.from },
        },
      ];
      const entries = choices.flatMap(({ period, level }) => {
        const ids = store.ids(scope, period, cutoff);
        const entry = engine.ready(scope, period, level, cutoff, ids)?.entry;
        return entry?.text ? [{ ...entry, timezone, ids }] : [];
      });
      return entries.length
        ? { entries, inputBudget: options.inputBudget, current: (ids) => store.current(scope, ids) }
        : undefined;
    },
    async answer(work: QueueHandlerInput): Promise<QueueCompletion | null> {
      if (!work.route || work.route.kind === 'initiative') return null;
      const source = await storage.contextMessages.get(work.scope, work.messageId);
      if (!source || !/(?:что|перескажи|сводку|итоги)/iu.test(source.text)) return null;
      const settings = await storage.contextState.settings(work.scope);
      if (!settings?.enabled) return null;
      const period = recapPeriod(source.text, source.timestamp, settings.timezone);
      if (!period) return null;
      const usage = createAttemptSummary(),
        started = Date.now();
      let firstDeadline: number | undefined;
      const run = buildRun(work.scope, work.messageId - 1, work, usage, () => {
        const deadline = firstDeadline;
        firstDeadline = undefined;
        return deadline;
      });
      const current = () =>
        run.current() && noticeBackend(storage).sourceVisible(work.scope, work.messageId);
      let text = '',
        entries: readonly number[] = [],
        sources: readonly number[] = [];
      let failure:
        | 'quota_exhausted'
        | 'token_budget_exhausted'
        | 'unavailable'
        | 'rate_limit'
        | 'llm_wait_timeout'
        | 'llm_provider_paused'
        | undefined;
      if (period === 'clarify')
        text = 'За какой период собрать пересказ? Укажи даты начала и конца.';
      else
        try {
          let notification: Promise<void> | undefined;
          const result = await recap(
            engine,
            store,
            {
              ...run,
              current,
              beforeRaw: () =>
                (notification ??= (async () => {
                  if (options.llmAdmission) {
                    firstDeadline = options.llmAdmission.waitUntil(work.deadline);
                    const ready = await options.llmAdmission.direct(
                      {
                        signal: work.signal,
                        jobSignal: work.signal,
                        waitDeadline: firstDeadline,
                        ...(work.deadline === undefined ? {} : { deadline: work.deadline }),
                        current,
                      },
                      () => true,
                    );
                    if (ready.kind !== 'ready')
                      throw new SummaryFailure(
                        ready.kind === 'background_busy' ? 'busy' : ready.kind,
                      );
                  }
                  const quota = work.checkRequestQuota?.();
                  if (quota === 'quota_exhausted') throw new SummaryFailure('quota');
                  if (quota === false) throw new SummaryFailure('cancelled');
                  const noticeStarted = performance.now();
                  await notify(work, source.messageId, current);
                  if (firstDeadline !== undefined)
                    firstDeadline = Math.min(
                      firstDeadline + performance.now() - noticeStarted,
                      work.deadline ?? Infinity,
                    );
                })()),
            },
            period,
          );
          text = result.text;
          entries = result.entries;
          sources = result.ids;
        } catch (error) {
          if (!(error instanceof SummaryFailure)) throw error;
          if (error.reason === 'cancelled') return { outcome: 'interrupted' };
          failure =
            error.reason === 'limit'
              ? 'token_budget_exhausted'
              : error.reason === 'quota'
                ? 'quota_exhausted'
                : error.reason === 'rate_limit' ||
                    error.reason === 'llm_wait_timeout' ||
                    error.reason === 'llm_provider_paused'
                  ? error.reason
                  : 'unavailable';
        }
      if (!failure && !usage.snapshot(0).attempts) {
        const admission = work.admitModelAttempt?.(current, [work.messageId]);
        if (admission === 'quota_exhausted') failure = admission;
        else if (!admission || admission === 'context_stale') return { outcome: 'interrupted' };
      }
      const summary = usage.snapshot(Date.now() - started);
      const result =
        failure === 'unavailable'
          ? {
              kind: 'error' as const,
              code: 'client_failure' as const,
              message: 'Сводка временно недоступна.',
              summary,
            }
          : failure
            ? { kind: failure, summary }
            : { kind: 'complete' as const, text, summary };
      work.recordTrace({
        summary,
        model: {
          name: summary.attempts ? options.model : null,
          invoked: summary.attempts ? 'yes' : 'no',
        },
        resultKind: result.kind,
      });
      return {
        result,
        outcome: failure === 'rate_limit' ? 'rate_limit' : failure ? 'failed' : 'completed',
        toolResultsCurrent: () => store.current(work.scope, entries),
        toolSourceIds: sources,
      };
    },
  };
}
