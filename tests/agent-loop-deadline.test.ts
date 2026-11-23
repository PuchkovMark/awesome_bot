import { afterEach, expect, test, vi } from 'vitest';
import { createAgentLoop } from '../src/core/index';
import type { LlmRequest, LlmResult } from '../src/llm/types';
import { agentInput, deferred, failure, response, sequence } from './helpers/agent-loop';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
test('зависший клиент ограничен общим сроком, signal отменён, поздний отказ наблюдаем', async () => {
  clock(); const pending = deferred<LlmResult>();
  const complete = vi.fn((request: LlmRequest) => { void request; return pending.promise; });
  const loop = createAgentLoop({ complete }, { timeoutMs: 20 });
  const result = loop.run(agentInput()); await vi.advanceTimersByTimeAsync(20);
  expect(await result).toMatchObject({ kind: 'deadline_exceeded', summary: { steps: 1, attempts: 1, durationMs: 20 } });
  expect(complete.mock.calls[0]![0].signal?.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  pending.reject(Error('PRIVATE')); await Promise.resolve(); await Promise.resolve();
});
test('пауза длиннее остатка срока не запускает повтор', async () => {
  clock(); const { loop, complete } = sequence([failure()], { timeoutMs: 50, retryDelayMs: 100 });
  const result = loop.run(agentInput()); await vi.advanceTimersByTimeAsync(50);
  expect(await result).toMatchObject({ kind: 'deadline_exceeded', summary: { attempts: 1, durationMs: 50 } });
  expect(complete).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
test('время первой попытки и паузы не обнуляется при повторе', async () => {
  clock(); const first = deferred<LlmResult>(), second = deferred<LlmResult>();
  const complete = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
  const loop = createAgentLoop({ complete }, { timeoutMs: 50, retryDelayMs: 10 });
  const result = loop.run(agentInput()); await vi.advanceTimersByTimeAsync(30); first.resolve(failure() as LlmResult);
  await vi.advanceTimersByTimeAsync(10); expect(complete).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({ kind: 'deadline_exceeded', summary: { attempts: 2, steps: 1, durationMs: 50 } });
  expect(vi.getTimerCount()).toBe(0); second.resolve(response() as LlmResult);
});
test('timeout клиента остаётся отдельной ошибкой и не повторяется', async () => {
  clock(); const { loop, complete } = sequence([failure('timeout')], { timeoutMs: 1000 });
  expect(await loop.run(agentInput())).toMatchObject({ kind: 'error', code: 'timeout', summary: { attempts: 1 } });
  expect(complete).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
test('время подготовки входа тоже расходует общий срок', async () => {
  clock(); const { loop, complete } = sequence([], { timeoutMs: 5 }); const input = agentInput();
  Object.defineProperty(input, 'system', { get() { vi.advanceTimersByTime(6); return 'prepared'; } });
  expect(await loop.run(input)).toMatchObject({ kind: 'deadline_exceeded', summary: { steps: 0, attempts: 0, durationMs: 6 } });
  expect(complete).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
test('перевод календарных часов не меняет монотонный срок', async () => {
  clock(); const { loop } = sequence([failure(), response()]); const result = loop.run(agentInput());
  vi.setSystemTime(new Date('2099-01-01T00:00:00Z')); await vi.advanceTimersByTimeAsync(1000);
  expect(await result).toMatchObject({ kind: 'complete', summary: { durationMs: 1000 } }); expect(vi.getTimerCount()).toBe(0);
});
test('ответ ровно на deadline не даёт вторичного успеха', async () => {
  clock(); const pending = deferred<LlmResult>(); const loop = createAgentLoop({ complete: () => pending.promise }, { timeoutMs: 10 });
  const result = loop.run(agentInput()); vi.advanceTimersByTime(10); pending.resolve(response() as LlmResult);
  expect(await result).toMatchObject({ kind: 'deadline_exceeded' }); expect(vi.getTimerCount()).toBe(0);
});
