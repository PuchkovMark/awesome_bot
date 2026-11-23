import {
  createAgentLoopQueue,
  createContextPreparation,
  createLifecycleService,
  createMessageRouter,
  createPublicationService,
} from '../core/index';
import type { PublicationRequest, QueueCompletion } from '../core/index';
import type { CapabilitySnapshot } from '../contracts/index';
import type { LlmClient, LlmRequest } from '../llm/types';
import { catalogAdministration } from '../storage/catalog-admin';
import { openStorage } from '../storage/index';
import type { TraceRecord } from '../storage/trace-types';
import type { EvaluationResult, Observation, Scenario } from './types';

const model = 'synthetic-local';
const loopTimeoutMs = 1_000;
const handlerMarginMs = 3_000;

function classifyFailure(
  completion: QueueCompletion,
  trace: TraceRecord,
): EvaluationResult['reason'] {
  if (completion.preparationFailure) return completion.preparationFailure;
  const result = completion.result;
  if (!result) return 'processing_failed';
  if (result.kind === 'error') return result.code;
  if (
    result.kind === 'attempt_limit' ||
    result.kind === 'rate_limit' ||
    result.kind === 'deadline_exceeded' ||
    result.kind === 'cancelled'
  )
    return result.kind;
  const { status, reason } = trace.payload.publication;
  if (status !== 'delivered' && (status !== 'suppressed' || reason === 'trace_write_failed'))
    return 'publication_failed';
  return null;
}

function classify(
  scenario: Scenario,
  trace: TraceRecord | null,
  reason: EvaluationResult['reason'],
  observation: Observation,
): EvaluationResult {
  const criteria = scenario.criteria.map(({ id, check }) => {
    if (reason) return { id, outcome: 'not_checked', reason: 'technical_error' } as const;
    return check(observation)
      ? ({ id, outcome: 'passed', reason: 'matched' } as const)
      : ({ id, outcome: 'failed', reason: 'mismatch' } as const);
  });
  return {
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
    model: trace?.payload.model.name ?? null,
    prompt: trace?.payload.prompt ?? null,
    outcome: reason
      ? 'technical_error'
      : criteria.every((criterion) => criterion.outcome === 'passed')
        ? 'passed'
        : 'failed',
    reason,
    criteria,
  };
}

async function waitForSettlement(
  settled: Promise<QueueCompletion>,
): Promise<QueueCompletion | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(resolve, loopTimeoutMs + handlerMarginMs + 500, null);
    });
    return await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runScenario(
  scenario: Scenario,
  client: LlmClient = {
    async complete() {
      return { kind: 'complete', text: scenario.answer, usage: { input: null, output: null } };
    },
  },
): Promise<EvaluationResult> {
  let request: LlmRequest | null = null;
  let answer: PublicationRequest | null = null;
  let trace: TraceRecord | null = null;
  let stage: EvaluationResult['reason'] = 'setup_failed';
  const evaluate = (reason: EvaluationResult['reason']) =>
    classify(scenario, trace, reason, {
      request,
      answer: trace?.payload.publication.status === 'delivered' ? answer : null,
      historyTruncated: trace?.payload.context?.historyTruncated ?? false,
    });

  try {
    const storage = await openStorage(':memory:');
    try {
      const lifecycle = createLifecycleService({
        storage,
        ownerId: 'synthetic:owner',
        source: {
          async observe() {
            return { confidence: 'confirmed', bot: 'present' };
          },
        },
      });
      const startChat = async (chatId: Scenario['input']['chatId']) => {
        const { scope } = await lifecycle.verify(chatId);
        if (!scope) throw Error('Отсутствует область синтетической беседы.');
        await storage.chats.create(scope, {
          enabled: true,
          responseMode: 'normal',
          timezone: 'UTC',
          createdAt: 0,
        });
        return scope;
      };
      const scope = await startChat(scenario.input.chatId);
      for (const message of scenario.history) {
        const target = message.chatId === scope.chatId ? scope : await startChat(message.chatId);
        await storage.messages.append(target, message);
      }
      const catalog = catalogAdministration(storage);
      const created = await catalog.append({
        key: 'eval',
        kind: 'system_prompt',
        text: scenario.prompt,
        createdAt: 0,
        expectedHead: null,
      });
      if (created.status !== 'created' || created.value.ref.area !== 'global')
        return evaluate('setup_failed');
      if ((await catalog.selectSystemPrompt(created.value.ref, null)).status !== 'selected')
        return evaluate('setup_failed');

      const preparation = createContextPreparation({
        storage,
        config: {
          modelContextTokens: 16_000,
          ...(scenario.historyLimit ? { maxHistoryMessages: scenario.historyLimit } : {}),
        },
        async capabilities({ chatId }): Promise<CapabilitySnapshot> {
          return {
            context: { chatId },
            observedAt: 0,
            maxMessageLength: 'unknown',
            textFormats: ['plain'],
            support: {
              send: 'supported',
              reply: 'supported',
              typing: 'unknown',
              getUserName: 'unknown',
              adminInfo: 'unknown',
              membershipEvents: 'unknown',
              directMessage: 'unknown',
            },
          };
        },
        now: () => 0,
        sessionId: () => 'synthetic-eval-session',
      });
      const publication = createPublicationService({
        storage,
        port: {
          async canReply() {
            return true;
          },
          async publish(message) {
            if (message.kind === 'answer') answer = message;
            return {
              kind: 'delivered',
              receipt: {
                messageId: 'published',
                userId: 'synthetic:bot',
                authorName: 'Бот',
                timestamp: 200,
              },
            };
          },
        },
      });
      const settlement = Promise.withResolvers<QueueCompletion>();
      const queue = createAgentLoopQueue({
        storage,
        tracing: { messageRetentionDays: 30 },
        modelName: model,
        loopOptions: { timeoutMs: loopTimeoutMs, maxAttemptsPerStep: 1 },
        config: { handlerMarginMs, stopTimeoutMs: 1_000 },
        prepare: preparation.prepare,
        client: {
          async complete(input) {
            request = input;
            return client.complete(input);
          },
        },
        async onSettled(work, completion) {
          try {
            await publication.onSettled(work, completion);
          } finally {
            settlement.resolve(completion);
          }
        },
      });
      try {
        stage = 'processing_failed';
        await queue.start();
        const router = createMessageRouter({ storage, queue });
        const routed = await router.receive(scope, scenario.input);
        if (routed.admission?.status !== 'queued') return evaluate('not_queued');
        const completion = await waitForSettlement(settlement.promise);
        trace = await storage.traces.get(scope, routed.admission.jobId);
        if (!completion) return evaluate('settlement_timeout');
        if (!trace) return evaluate('trace_missing');
        return evaluate(classifyFailure(completion, trace));
      } finally {
        await queue.stop();
      }
    } finally {
      await storage.close();
    }
  } catch {
    return evaluate(stage);
  }
}
