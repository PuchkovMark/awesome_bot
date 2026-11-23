import { afterEach, expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/index';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import { agentInput, deferred, failure, response } from './helpers/agent-loop';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
test('параллельные запуски и обратные ответы не смешивают сессии и сводки', async () => {
  const a = deferred<LlmResult>(),
    b = deferred<LlmResult>();
  const complete = vi.fn((request: LlmRequest) =>
    request.sessionId === 'a' ? a.promise : b.promise,
  );
  const loop = createAgentLoop({ complete });
  const first = loop.run(agentInput({ sessionId: 'a', messages: [{ role: 'user', text: 'A' }] }));
  const second = loop.run(agentInput({ sessionId: 'b', messages: [{ role: 'user', text: 'B' }] }));
  b.resolve(response('complete', { text: 'B', usage: { input: 3, output: 4 } }) as LlmResult);
  expect(await second).toMatchObject({
    text: 'B',
    summary: { attempts: 1, usage: { input: { knownTokens: 3 } } },
  });
  a.resolve(response('complete', { text: 'A' }) as LlmResult);
  expect(await first).toMatchObject({
    text: 'A',
    summary: { attempts: 1, usage: { input: { knownTokens: 10 } } },
  });
  expect(complete.mock.calls.map(([request]) => request.messages[0])).toEqual([
    { role: 'user', text: 'A' },
    { role: 'user', text: 'B' },
  ]);
});
test('отмена одного запуска не отменяет второй', async () => {
  const pending = deferred<LlmResult>();
  const controller = new AbortController();
  const complete = vi.fn((request: LlmRequest) =>
    request.sessionId === 'a' ? new Promise<LlmResult>(() => {}) : pending.promise,
  );
  const loop = createAgentLoop({ complete });
  const a = loop.run(agentInput({ sessionId: 'a', signal: controller.signal }));
  const b = loop.run(agentInput({ sessionId: 'b' }));
  controller.abort();
  expect(await a).toMatchObject({ kind: 'cancelled' });
  expect(complete.mock.calls[1]![0].signal?.aborted).toBe(false);
  pending.resolve(response() as LlmResult);
  expect(await b).toMatchObject({ kind: 'complete', summary: { attempts: 1 } });
});
test('снимок конфигурации/входа и собственные копии для попыток', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const config = { maxAttemptsPerStep: 2, retryDelayMs: 5, retryServerErrors: true };
  const messages = [{ role: 'user' as const, text: 'ORIGINAL' }];
  const input = { ...agentInput(), messages };
  let calls = 0;
  const complete = vi.fn(async (request: LlmRequest): Promise<LlmResult> => {
    calls++;
    if (calls === 1) {
      (request.messages[0] as { text: string }).text = 'MUTATED BY CLIENT';
      (request as { system: string }).system = 'MUTATED';
      return failure() as LlmResult;
    }
    expect(request.system).toBe('Системные инструкции');
    expect(request.messages[0]).toEqual({ role: 'user', text: 'ORIGINAL' });
    expect(request.sessionId).toBe('synthetic');
    expect(request.maxOutputTokens).toBe(128);
    return response() as LlmResult;
  });
  const loop = createAgentLoop({ complete }, config);
  config.maxAttemptsPerStep = 1;
  config.retryServerErrors = false;
  config.retryDelayMs = 9999;
  const result = loop.run(input);
  messages[0]!.text = 'MUTATED OUTSIDE';
  input.system = 'MUTATED';
  input.sessionId = 'changed';
  input.maxOutputTokens = 999;
  await vi.advanceTimersByTimeAsync(5);
  expect(await result).toMatchObject({ kind: 'complete', summary: { steps: 1, attempts: 2 } });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
test('исходная история не изменяется запуском и зависимость клиента фиксируется при создании', async () => {
  const input = agentInput();
  const before = JSON.stringify(input);
  const client = { complete: vi.fn(async () => response() as LlmResult) };
  const loop = createAgentLoop(client);
  client.complete = vi.fn(async () => failure('rate_limit') as LlmResult);
  expect(await loop.run(input)).toMatchObject({ kind: 'complete' });
  expect(JSON.stringify(input)).toBe(before);
});
