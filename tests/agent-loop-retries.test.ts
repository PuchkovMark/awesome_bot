import { afterEach, expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/agent-loop/service';
import type { AttemptAdmission } from '../src/core/agent-loop/types';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import { agentInput, failure, response, sequence } from './helpers/agent-loop';

afterEach(() => {
  vi.useRealTimers();
});
function clock() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
}
test('server повторяется по умолчанию внутри одного шага', async () => {
  clock();
  const { loop, complete } = sequence([failure(), response()], { maxSteps: 1 });
  const result = loop.run(agentInput());
  await vi.advanceTimersByTimeAsync(999);
  expect(complete).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toMatchObject({
    kind: 'complete',
    summary: {
      steps: 1,
      attempts: 2,
      attemptsPerStep: [2],
      durationMs: 1000,
      usage: {
        input: { knownTokens: 10, unknownAttempts: 1 },
        output: { knownTokens: 2, unknownAttempts: 1 },
      },
    },
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
test('серия server останавливается по попыткам, не начинает второй шаг', async () => {
  clock();
  const { loop, complete } = sequence([failure(), failure(), failure()], {
    maxSteps: 6,
    maxAttemptsPerStep: 3,
    retryDelayMs: 5,
  });
  const result = loop.run(agentInput());
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({
    kind: 'attempt_limit',
    lastErrorCode: 'server',
    summary: {
      steps: 1,
      attempts: 3,
      attemptsPerStep: [3],
      usage: { input: { knownTokens: 0, unknownAttempts: 3 } },
    },
  });
  expect(complete).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(0);
});
test('успех последней разрешённой попытки остаётся успехом', async () => {
  clock();
  const { loop } = sequence([failure(), failure(), response()], {
    maxAttemptsPerStep: 3,
    retryDelayMs: 5,
  });
  const result = loop.run(agentInput());
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ kind: 'complete', summary: { attempts: 3, steps: 1 } });
});
test('владелец может выключить server-повторы, но не расширить категории', async () => {
  const { loop, complete } = sequence([failure()], {
    retryServerErrors: false,
    maxAttemptsPerStep: 10,
  });
  expect(await loop.run(agentInput())).toMatchObject({
    kind: 'error',
    code: 'server',
    summary: { attempts: 1 },
  });
  expect(complete).toHaveBeenCalledOnce();
});
test('maxAttemptsPerStep включает первую попытку', async () => {
  const { loop, complete } = sequence([failure()], { maxAttemptsPerStep: 1 });
  expect(await loop.run(agentInput())).toMatchObject({
    kind: 'attempt_limit',
    summary: { steps: 1, attempts: 1 },
  });
  expect(complete).toHaveBeenCalledOnce();
});
test.each([
  'rate_limit',
  'network',
  'timeout',
  'forbidden',
  'authentication',
  'invalid_request',
  'invalid_response',
  'unsupported_response',
  'response_too_large',
  'http',
])('%s не повторяется при свободном бюджете шагов/попыток', async (code) => {
  clock();
  const { loop, complete } = sequence([failure(code)], { maxSteps: 100, maxAttemptsPerStep: 100 });
  const result = await loop.run(agentInput());
  expect(result).toMatchObject(
    code === 'rate_limit' ? { kind: 'rate_limit' } : { kind: 'error', code },
  );
  expect(complete).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test('повтор не дополняет историю ошибкой и не меняет служебные поля', async () => {
  clock();
  const { loop, complete } = sequence([failure(), response()]);
  const result = loop.run(agentInput());
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  const [first, second] = complete.mock.calls.map(([request]) => request);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  expect(second?.messages).not.toBe(first?.messages);
  expect(JSON.stringify(second)).not.toContain('UNTRUSTED');
});

test('каждый повтор запрашивает допуск перед вызовом и останавливается при нехватке токенов', async () => {
  clock();
  const complete = vi.fn(async (): Promise<LlmResult> => ({
    kind: 'error',
    code: 'server',
    message: 'Сбой',
  }));
  const admission = vi
    .fn<(_request: Readonly<LlmRequest>, _ordinal: number) => AttemptAdmission>()
    .mockReturnValueOnce(true)
    .mockReturnValueOnce('token_budget_exhausted');
  const loop = createAgentLoop({ complete }, { retryDelayMs: 5 }, undefined, admission);
  const result = loop.run(agentInput());
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({ kind: 'token_budget_exhausted', summary: { attempts: 1 } });
  expect(complete).toHaveBeenCalledOnce();
  expect(admission.mock.calls.map(([, ordinal]) => ordinal)).toEqual([1, 2]);
  expect(admission.mock.calls[0]?.[0].maxOutputTokens).toBe(agentInput().maxOutputTokens);
});
