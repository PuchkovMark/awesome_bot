import { messageInputCost, systemInputCost } from '../context/budget';
import type { LlmClient, LlmRequest } from '../../llm/types';
import type { AgentLoopInput, AgentLoopOptions } from '../agent-loop/types';
import { createAttemptSummary } from '../agent-loop/summary';
import { createAgentLoop } from '../agent-loop/service';
import { loopOptions } from '../agent-loop/validation';
import { createChatQueue } from './service';
import { queueConfig } from './validation';
import { QueueError } from './errors';
import type { ChatQueueOptions, QueueHandlerInput, QueueConfig, QueueCompletion } from './types';
import type { PreparationResult } from '../context/types';
export type QueuePreparation =
  | {
      readonly kind: 'ready';
      readonly input: Omit<AgentLoopInput, 'signal'>;
      readonly metadata?: import('../context/types').ContextMetadata;
      readonly authorLabels?: readonly string[];
    }
  | Exclude<PreparationResult, { kind: 'ready' }>;
export interface AgentLoopQueueOptions extends Omit<ChatQueueOptions, 'handler' | 'config'> {
  readonly modelName: string;
  readonly client: LlmClient;
  readonly loopOptions?: AgentLoopOptions;
  readonly config?: Omit<Partial<QueueConfig>, 'loopTimeoutMs'>;
  readonly preparationTimeoutMs?: number;
  readonly postPreparationMarginMs?: number;
  readonly signal?: AbortSignal;
  readonly prepare: (work: QueueHandlerInput) => Promise<QueuePreparation>;
  readonly disclosure?: (
    work: QueueHandlerInput,
  ) => import('../../storage/trace-types').TracePayload['disclosure'];
}
function estimateRequestInput(request: LlmRequest) {
  return (
    request.messages.reduce((cost, message) => {
      const structured =
        message.role === 'tool' || (message.role === 'assistant' && message.toolCalls);
      const text = structured ? JSON.stringify(message) : (message.text ?? '');
      return cost + messageInputCost(Buffer.byteLength(text, 'utf8'));
    }, systemInputCost(request.system)) +
    (request.tools ? Buffer.byteLength(JSON.stringify(request.tools), 'utf8') : 0)
  );
}

export function createAgentLoopQueue(options: AgentLoopQueueOptions) {
  const settings = loopOptions(options.loopOptions ?? {});
  if (
    typeof options.modelName !== 'string' ||
    !options.modelName.trim() ||
    Buffer.byteLength(options.modelName) > 1024
  )
    throw new TypeError('Tracing: invalid_configuration');
  const modelName = options.modelName,
    client = { complete: options.client.complete.bind(options.client) };
  const prep = options.preparationTimeoutMs ?? 2000,
    margin = options.postPreparationMarginMs ?? 1000;
  const config = queueConfig({ ...options.config, loopTimeoutMs: settings.timeoutMs });
  if (
    !Number.isSafeInteger(prep) ||
    prep <= 0 ||
    prep > 2147483647 ||
    !Number.isSafeInteger(margin) ||
    margin <= 0 ||
    config.handlerTimeoutMs < settings.timeoutMs + prep + margin
  )
    throw new QueueError('invalid_input');
  return createChatQueue({
    tracing: options.tracing,
    storage: options.storage,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.onSettled ? { onSettled: options.onSettled } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    config,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.responseRate === undefined ? {} : { responseRate: options.responseRate }),
    ...(options.tokenBudget ? { tokenBudget: true } : {}),
    ...(options.autonomousReplies ? { autonomousReplies: true } : {}),
    handler: async (work) => {
      const zero = createAttemptSummary().snapshot(0);
      work.recordTrace({ summary: zero });
      const initialDisclosure = options.disclosure?.(work);
      if (initialDisclosure && !initialDisclosure.allowed) {
        work.recordTrace({ disclosure: initialDisclosure });
        return 'interrupted';
      }
      const lifetime = options.signal
        ? AbortSignal.any([work.signal, options.signal])
        : work.signal;
      const preparationDeadline = performance.now() + prep;
      async function prepare(): Promise<QueuePreparation> {
        const remaining = preparationDeadline - performance.now();
        if (remaining <= 0) return { kind: 'deadline_exceeded' };
        const controller = new AbortController(),
          signal = AbortSignal.any([lifetime, controller.signal]);
        let abort: () => void = () => {};
        const interrupted = new Promise<QueuePreparation>((resolve) => {
          abort = () => resolve({ kind: lifetime.aborted ? 'cancelled' : 'deadline_exceeded' });
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        const timer = setTimeout(() => controller.abort(), Math.ceil(remaining));
        try {
          return await Promise.race([
            Promise.resolve().then(() =>
              signal.aborted
                ? { kind: 'cancelled' as const }
                : options.prepare({ ...work, signal }),
            ),
            interrupted,
          ]);
        } finally {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
        }
      }
      for (;;) {
        const prepared = await prepare();
        if (lifetime.aborted || !work.isCurrent()) return 'interrupted';
        if (prepared.kind === 'cancelled') return 'interrupted';
        if (prepared.kind === 'deadline_exceeded') return 'deadline_exceeded';
        if (prepared.kind === 'unavailable') return 'message_missing';
        if (prepared.kind === 'failed') {
          const allowed = [
            'missing_system_prompt',
            'static_budget_too_small',
            'current_message_too_large',
            'internal_error',
          ];
          return {
            outcome: 'failed',
            ...(allowed.includes(prepared.reason) ? { preparationFailure: prepared.reason } : {}),
          } satisfies QueueCompletion;
        }
        if (prepared.kind !== 'ready') return 'failed';
        // Финальная синхронная проверка выполняется непосредственно перед запуском цикла.
        if (!work.isCurrent() || lifetime.aborted) return 'interrupted';
        work.recordTrace({
          prompt: prepared.metadata?.version ?? null,
          context: prepared.metadata ?? null,
        });
        const allowed = () => {
          if (lifetime.aborted) return false;
          const checked = options.disclosure?.(work);
          if (checked) work.recordTrace({ disclosure: checked });
          return checked?.allowed ?? true;
        };
        let staleContext = false;
        const loop = createAgentLoop(
          client,
          settings,
          (summary) =>
            work.recordTrace({ model: { name: modelName, invoked: 'possible' }, summary }),
          (request, ordinal) => {
            const reservation =
              options.tokenBudget && work.route
                ? {
                    key: `job:${work.jobId}:${ordinal}`,
                    purpose: 'direct' as const,
                    input: estimateRequestInput(request),
                    output: request.maxOutputTokens,
                  }
                : undefined;
            const admission = work.admitModelAttempt
              ? work.admitModelAttempt(allowed, prepared.metadata?.messageIds, reservation)
              : work.isCurrent() && allowed();
            staleContext = admission === 'context_stale';
            return admission;
          },
        );
        const result = await loop.run({ ...prepared.input, signal: lifetime });
        if (staleContext && result.summary.attempts === 0) continue;
        work.recordTrace({
          model: {
            name: result.summary.attempts ? modelName : null,
            invoked: result.summary.attempts ? 'yes' : 'no',
          },
          summary: result.summary,
          resultKind: result.kind,
        });
        const outcome =
          result.kind === 'complete'
            ? 'completed'
            : result.kind === 'rate_limit'
              ? 'rate_limit'
              : result.kind === 'deadline_exceeded'
                ? 'deadline_exceeded'
                : result.kind === 'cancelled'
                  ? 'interrupted'
                  : 'failed';
        return {
          outcome,
          result,
          ...(prepared.authorLabels?.length ? { authorLabels: prepared.authorLabels } : {}),
        };
      }
    },
  });
}
