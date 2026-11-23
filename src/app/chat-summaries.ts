import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatId, ConnectionScope } from '../contracts/index';
import type { LlmClient } from '../llm/types';
import { createLlmSessionId } from '../llm/session';
import { estimateRequestInput } from '../core/context/budget';
import { createAttemptSummary } from '../core/agent-loop/summary';
import type { QueueHandlerInput } from '../core/chat-queue/types';
import type { PublicationPort } from '../core/message-router/publication-service';
import type { Storage } from '../storage/index';
import { chatSummaryStore } from '../storage/chat-summary-store';
import { tokenBudgetStore } from '../storage/token-budget-store';
import { lifecycleBackend } from '../storage/lifecycle-store';
import { summaryEngine, type SummaryRun } from '../core/chat-summaries/worker';
import { SummaryFailure } from '../core/chat-summaries/compress';

export function applicationSummaries(options: {
  storage: Storage;
  client: LlmClient;
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
  ): SummaryRun {
    const abort = work?.signal ?? signal;
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
        async invoke(request) {
          if (!current()) throw new SummaryFailure('cancelled');
          const attempt = {
            key: 'summary:' + randomUUID(),
            purpose: work ? ('direct' as const) : ('summary' as const),
            input: estimateRequestInput(request),
            output: request.maxOutputTokens,
          };
          const admission = work
            ? work.admitModelAttempt?.(current, [], attempt)
            : budgets.reserve(scope, options.group(scope.chatId), attempt, Date.now());
          if (admission === 'quota_exhausted') throw new SummaryFailure('quota');
          if (!admission || admission === 'context_stale') throw new SummaryFailure('cancelled');
          if (typeof admission === 'string') throw new SummaryFailure('limit');
          usage.beginAttempt();
          work?.recordTrace({
            model: { name: options.model, invoked: 'possible' },
            summary: usage.snapshot(0),
          });
          const response = await options.client.complete(request).catch(() => {
            throw new SummaryFailure(abort.aborted ? 'cancelled' : 'unavailable');
          });
          if ('usage' in response) {
            usage.recordUsage(response.usage);
            if (typeof admission === 'object') admission.recordUsage(response.usage);
            else budgets.reconcile(scope, attempt.key, response.usage);
          }
          return response;
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
  return {
    async run() {
      while (!signal.aborted) {
        await tick();
        await delay(options.intervalMs, undefined, { signal }).catch((error) => {
          if (!signal.aborted) throw error;
        });
      }
    },
  };
}
