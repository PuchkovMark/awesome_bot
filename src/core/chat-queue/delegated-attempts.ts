import type { LlmClient, LlmRequest, LlmUsage } from '../../llm/types';
import {
  createDelegation,
  type DelegateResult,
  type DelegationHost,
} from '../agent-loop/delegation';
import { toolAuthorization } from '../../tools/authorization';
import type { ToolContext } from '../../contracts/tool';
import type { QueueHandlerInput } from './types';
import type { AgentLoopOptions } from '../agent-loop/types';
import { estimateRequestInput, messageInputCost } from '../context/budget';
import { scheduleLlmCall, type LlmAdmission, type SendLlmCall } from '../llm-admission';

const resultEnvelopeBytes = 4096;

export function fitsToolEnvelope(callId: string, text: string) {
  return (
    Buffer.byteLength(JSON.stringify({ role: 'tool', callId, text })) <=
    resultEnvelopeBytes + Buffer.byteLength(JSON.stringify(callId))
  );
}

/** Верхняя граница относится к сериализации целого сообщения tool для оценки F4.6. */
export function delegateFeedback(callId: string, result: DelegateResult) {
  const { status, answer, citations, gaps } = result;
  const message = {
    role: 'tool' as const,
    callId,
    text: JSON.stringify({ status, answer, citations, gaps }),
  };
  if (!fitsToolEnvelope(callId, message.text))
    message.text = JSON.stringify({
      status: 'incomplete',
      gaps: ['Результат превысил допустимый размер.'],
    });
  return message;
}

/** Прогноз включает основное сообщение assistant с вызовами и уже полученные ответы инструментов. */
export function finalRequestReserve(request: LlmRequest, pending: readonly string[]) {
  return (
    estimateRequestInput(request) +
    request.maxOutputTokens +
    pending.reduce(
      (sum, id) =>
        sum + messageInputCost(resultEnvelopeBytes + Buffer.byteLength(JSON.stringify(id))),
      0,
    )
  );
}

/** Создаётся один раз для задания. Родитель и помощники делят ordinal, допуск и срок. */
export function createJobModelAttempts(
  work: QueueHandlerInput,
  allow: () => boolean,
  admission?: LlmAdmission,
) {
  let ordinal = 0;
  let helperFailure: 'rate_limit' | 'llm_wait_timeout' | 'llm_provider_paused' | undefined;
  // Повтор сохраняет объект запроса. Продолжение после чтения получает новый.
  const helperUsage = new Map<LlmRequest, LlmUsage[]>();
  function reserve(
    request: LlmRequest,
    ids: readonly number[],
    final?: import('../../storage/token-budget-store').FinalBudget,
  ) {
    if (
      !work.route ||
      !work.admitModelAttempt ||
      work.signal.aborted ||
      !work.isCurrent() ||
      !allow()
    )
      return false;
    return work.admitModelAttempt(
      allow,
      ids,
      {
        key: 'job:' + work.jobId + ':' + ++ordinal,
        purpose: work.route.kind === 'initiative' ? 'initiative' : 'direct',
        input: estimateRequestInput(request),
        output: request.maxOutputTokens,
      },
      final,
    );
  }
  return {
    reserve,
    helperSummary: () => [...helperUsage.values()],
    helperFailure: () => helperFailure,
    async helper(
      client: LlmClient,
      request: LlmRequest,
      ids: readonly number[],
      protectedTokens: number,
      current: () => boolean,
    ) {
      const proceed = () => current() && helperFailure === undefined;
      const perform = (send: SendLlmCall) => {
        const admitted = reserve(request, ids, { protect: protectedTokens });
        if (typeof admitted !== 'object') return;
        if (!allow() || !proceed()) {
          admitted.cancelBeforeSend();
          return;
        }
        return send(async () => {
          const step = helperUsage.get(request) ?? [];
          helperUsage.set(request, step);
          const slot = step.push({ input: null, output: null }) - 1;
          let result;
          try {
            result = await client.complete(request);
          } catch {
            result = { kind: 'error', code: 'network', message: 'Сбой модели помощника.' } as const;
          }
          if (result.kind === 'error' && result.code === 'rate_limit') helperFailure = 'rate_limit';
          if ('usage' in result) {
            step[slot] = result.usage;
            admitted.recordUsage(result.usage);
          }
          return result;
        }, admitted.cancelBeforeSend);
      };
      const scheduled = await scheduleLlmCall(
        admission,
        {
          signal: request.signal ?? work.signal,
          jobSignal: work.signal,
          current: proceed,
          ...(work.deadline === undefined ? {} : { deadline: work.deadline }),
        },
        perform,
      );
      if (scheduled.kind === 'ready') return scheduled.value;
      if (scheduled.kind === 'llm_wait_timeout' || scheduled.kind === 'llm_provider_paused') {
        helperFailure ??= scheduled.kind;
      }
    },
  };
}

/** Вызывается реестром родительского цикла, когда он выдаёт delegate. */
export function createJobDelegation(options: {
  work: QueueHandlerInput;
  client: LlmClient;
  attempts: ReturnType<typeof createJobModelAttempts>;
  materials: Pick<DelegationHost, 'resolve' | 'visible' | 'allowedTools' | 'read'>;
  principal: ToolContext;
  signal: AbortSignal;
  settings: Required<AgentLoopOptions>;
  isLoopCurrent: () => boolean;
  parentSteps: () => number;
  finalRequest: () => { request: LlmRequest; pending: readonly string[] };
}) {
  const { work, principal } = options;
  const auth = toolAuthorization(principal);
  if (
    !auth.allowed ||
    auth.value.scope.chatId !== work.scope.chatId ||
    auth.value.scope.generation !== work.scope.generation
  )
    throw new TypeError('Некорректная область делегирования.');
  const initial = options.finalRequest().request;
  const signal = AbortSignal.any([work.signal, options.signal]);
  let helperSteps = 0;
  const current = (ids: readonly number[]) =>
    !signal.aborted &&
    work.isCurrent() &&
    options.materials.visible(ids) &&
    options.isLoopCurrent();
  const execute = createDelegation({
    ...options.materials,
    sessionId: initial.sessionId,
    maxOutputTokens: initial.maxOutputTokens,
    signal,
    retry: options.settings,
    visible: current,
    takeHelperStep() {
      if (helperSteps + options.parentSteps() + 1 >= options.settings.maxSteps) return false;
      helperSteps++;
      return true;
    },
    attempt(request, ids) {
      const final = options.finalRequest();
      return options.attempts.helper(
        options.client,
        request,
        ids,
        finalRequestReserve(final.request, final.pending),
        () => current(ids),
      );
    },
  });
  return { execute, helperSteps: () => helperSteps };
}
