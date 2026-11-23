import type { LlmClient, LlmRequest } from '../../llm/types';
import {
  createDelegation,
  type DelegateResult,
  type DelegationHost,
} from '../agent-loop/delegation';
import { toolAuthorization } from '../../tools/authorization';
import type { ToolContext } from '../../contracts/tool';
import type { QueueHandlerInput } from './types';
import { estimateRequestInput, messageInputCost } from '../context/budget';

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
export function createJobModelAttempts(work: QueueHandlerInput, allow: () => boolean) {
  let ordinal = 0;
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
    async helper(
      client: LlmClient,
      request: LlmRequest,
      ids: readonly number[],
      protectedTokens: number,
      startUsage?: () => (usage: import('../../llm/types').LlmUsage) => void,
    ) {
      const admitted = reserve(request, ids, { protect: protectedTokens });
      if (typeof admitted !== 'object') return;
      if (work.signal.aborted || request.signal?.aborted || !work.isCurrent() || !allow()) {
        admitted.cancelBeforeSend();
        return;
      }
      const onUsage = startUsage?.();
      let result;
      try {
        result = await client.complete(request);
      } catch {
        onUsage?.({ input: null, output: null });
        throw Error('Сбой модели помощника.');
      }
      onUsage?.('usage' in result ? result.usage : { input: null, output: null });
      if ('usage' in result) admitted.recordUsage(result.usage);
      return result;
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
  maxSteps: number;
  startUsage?: () => (usage: import('../../llm/types').LlmUsage) => void;
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
  const execute = createDelegation({
    ...options.materials,
    sessionId: initial.sessionId,
    maxOutputTokens: initial.maxOutputTokens,
    signal,
    visible: (ids) => work.isCurrent() && options.materials.visible(ids),
    takeHelperStep() {
      if (helperSteps + options.parentSteps() + 1 >= options.maxSteps) return false;
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
        options.startUsage,
      );
    },
  });
  return { execute, helperSteps: () => helperSteps };
}
