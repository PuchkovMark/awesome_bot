import { afterEach, expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/index.js';
import type { LlmRequest, LlmResult } from '../src/llm/types.js';
import { agentInput, deferred, failure, response, sequence } from './helpers/agent-loop.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
function tracked() {
  const controller = new AbortController();
  return { controller, add: vi.spyOn(controller.signal, 'addEventListener'), remove: vi.spyOn(controller.signal, 'removeEventListener') };
}
test('предварительная отмена не создаёт шаг, попытку, слушатель или таймер', async () => {
  clock(); const { controller, add } = tracked(); controller.abort('PRIVATE');
  const { loop, complete } = sequence([]);
  expect(await loop.run(agentInput({ signal: controller.signal }))).toMatchObject({ kind: 'cancelled', summary: { steps: 0, attempts: 0, attemptsPerStep: [] } });
  expect(complete).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
test('отмена зависшего клиента завершает run и не передаёт приватный reason', async () => {
  clock(); const { controller, add, remove } = tracked(); const pending = deferred<LlmResult>();
  const complete = vi.fn((request: LlmRequest) => { void request; return pending.promise; }); const loop = createAgentLoop({ complete });
  const result = loop.run(agentInput({ signal: controller.signal }));
  const signal = complete.mock.calls[0]![0].signal;
  controller.abort('PRIVATE_REASON');
  expect(signal?.aborted).toBe(true); expect(String(signal?.reason)).not.toContain('PRIVATE_REASON');
  const value = await result;
  expect(value).toMatchObject({ kind: 'cancelled', summary: { steps: 1, attempts: 1, usage: { input: { unknownAttempts: 1 } } } });
  expect(JSON.stringify(value)).not.toContain('PRIVATE');
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]); expect(vi.getTimerCount()).toBe(0);
  pending.reject(Error('PRIVATE_LATE_FAILURE')); await Promise.resolve(); await Promise.resolve();
});
test('отмена во время паузы исключает вторую попытку', async () => {
  clock(); const controller = new AbortController(); const { loop, complete } = sequence([failure(), response()]);
  const result = loop.run(agentInput({ signal: controller.signal }));
  await vi.advanceTimersByTimeAsync(999); controller.abort();
  expect(await result).toMatchObject({ kind: 'cancelled', summary: { attempts: 1, steps: 1 } });
  await vi.advanceTimersByTimeAsync(1000); expect(complete).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
test('отмена повторной попытки и поздний usage не меняют результат', async () => {
  clock(); const controller = new AbortController(); const pending = deferred<LlmResult>(); let calls = 0;
  const complete = vi.fn(async () => { calls++; return calls === 1 ? failure() as LlmResult : pending.promise; });
  const loop = createAgentLoop({ complete }); const result = loop.run(agentInput({ signal: controller.signal }));
  await vi.advanceTimersByTimeAsync(1000); expect(complete).toHaveBeenCalledTimes(2); controller.abort();
  const value = await result; const snapshot = JSON.stringify(value);
  expect(value).toMatchObject({ kind: 'cancelled', summary: { steps: 1, attempts: 2, usage: { input: { unknownAttempts: 2 } } } });
  pending.resolve(response() as LlmResult); await Promise.resolve(); await Promise.resolve();
  expect(JSON.stringify(value)).toBe(snapshot); expect(Object.isFrozen(value.summary.usage.input)).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
test.each([response(), response('incomplete'), response('refused'), response('empty'), response('tool_calls'), failure('rate_limit'), failure('network'), null])('конечный исход очищает ресурсы', async (value) => {
  clock(); const { controller, add, remove } = tracked(); const { loop } = sequence([value]);
  await loop.run(agentInput({ signal: controller.signal }));
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]); expect(vi.getTimerCount()).toBe(0);
});
test('исчерпание попыток очищает deadline и паузу', async () => {
  clock(); const { controller, add, remove } = tracked(); const { loop } = sequence([failure(), failure()]);
  const result = loop.run(agentInput({ signal: controller.signal })); await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ kind: 'attempt_limit' });
  expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]); expect(vi.getTimerCount()).toBe(0);
});
test('гонка успеха с отменой даёт один конечный исход', async () => {
  clock(); const pending = deferred<LlmResult>(); const controller = new AbortController();
  const loop = createAgentLoop({ complete: () => pending.promise }); const observer = vi.fn();
  const result = loop.run(agentInput({ signal: controller.signal })).then(observer);
  pending.resolve(response() as LlmResult); controller.abort(); await result;
  expect(observer).toHaveBeenCalledOnce(); expect(observer.mock.calls[0]![0]).toMatchObject({ kind: 'cancelled' }); expect(vi.getTimerCount()).toBe(0);
});
