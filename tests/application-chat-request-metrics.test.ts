import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import type { MetricsSeries } from '../src/contracts/chat-metrics';
import { createChatQueue } from '../src/core/index';
import { queueConfig } from '../src/core/chat-queue/validation';
import { chatRequestMetricsStore } from '../src/storage/chat-request-metrics-store';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import type { Storage } from '../src/storage/types';
import type { LlmRequest, LlmResult, LlmToolCall } from '../src/llm/types';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { answer, fixture, mention, peer } from './helpers/application-response-fixture';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { scopeFor } from './helpers/connection-scope';

function totals(storage: Storage, scope: ConnectionScope, series: MetricsSeries) {
  return chatRequestMetricsStore(storage)
    .read(scope, 'day', 0, Date.now())
    .buckets.find((row) => row.series === series)?.totals;
}
const requests = (storage: Storage, scope: ConnectionScope) => totals(storage, scope, 'requests');

const tools = (input: number | null, output: number | null, ...calls: LlmToolCall[]) =>
  ({
    kind: 'tool_calls',
    text: null,
    calls,
    usage: { input, output },
  }) as const;
const delegate = (id: string, readers: string[] = []) => ({
  id,
  name: 'delegate',
  arguments: JSON.stringify({ goal: 'Закрытая цель', sources: ['current'], tools: readers }),
});
const read = { id: 'закрытый-id', name: 'history_search', arguments: '{"query":"Маяк","limit":1}' };
const helperAnswer = {
  ...answer,
  text: '{"answer":"Результат","citations":["current"],"gaps":[]}',
  usage: { input: 15, output: 5 },
};

test(
  'чтение и повтор субагента дают отдельные шаги, попытки и инструменты',
  { timeout: 10_000 },
  async () => {
    const app = await fixture();
    try {
      tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
      app.complete
        .mockResolvedValueOnce(tools(30, 5, delegate('закрытое-поручение', ['history_search'])))
        .mockResolvedValueOnce(tools(10, 0, read))
        .mockResolvedValueOnce({ kind: 'error', code: 'server', message: 'Сбой провайдера' })
        .mockResolvedValueOnce(helperAnswer)
        .mockResolvedValueOnce({ ...answer, usage: { input: 30, output: 5 } });
      const input = app.submit(mention);
      await app.trace(input, 5_000);
      expect(app.complete).toHaveBeenCalledTimes(5);
      expect(requests(app.storage, app.scope)?.requests).toBe(1n);
      expect(totals(app.storage, app.scope, 'main')).toMatchObject({
        steps: 2n,
        attempts: 2n,
        errors: 0n,
        tools: 1n,
      });
      expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
        steps: 2n,
        attempts: 3n,
        errors: 1n,
        tools: 1n,
        branches_started: 1n,
        branches_finished: 1n,
      });
      expect(
        JSON.stringify(app.db.prepare('SELECT * FROM chat_metrics_attempts').all()),
      ).not.toMatch(/закрыт|Маяк|Сбой|Результат/u);
    } finally {
      await app.close();
    }
  },
);

test('повтор поручения использует готовый результат, параллельные субагенты имеют разные шаги', async () => {
  const first = Promise.withResolvers<LlmResult>();
  const second = Promise.withResolvers<LlmResult>();
  const main = vi
    .fn<(request: LlmRequest) => Promise<LlmResult>>()
    .mockResolvedValueOnce(tools(1, 1, delegate('first'), delegate('second')))
    .mockResolvedValueOnce(tools(1, 1, delegate('first')))
    .mockResolvedValueOnce(answer);
  const assistant = vi
    .fn<(request: LlmRequest) => Promise<LlmResult>>()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  const app = await fixture({
    modelClients: { client: { complete: main }, auxiliaryClient: { complete: assistant } },
  });
  try {
    tokenBudgetStore(app.storage).update(app.scope, true, { total: 100_000 }, app.start);
    const input = app.submit(mention);
    await vi.waitFor(() => expect(assistant).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
      interval: 5,
    });
    expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
      steps: 2n,
      branches_started: 2n,
      branches_finished: 0n,
    });
    second.resolve(helperAnswer);
    first.resolve(helperAnswer);
    await app.published(input);
    expect(main).toHaveBeenCalledTimes(3);
    expect(assistant).toHaveBeenCalledTimes(2);
    expect(totals(app.storage, app.scope, 'main')).toMatchObject({
      steps: 3n,
      attempts: 3n,
      tools: 2n,
    });
    expect(totals(app.storage, app.scope, 'subagent')).toMatchObject({
      steps: 2n,
      attempts: 2n,
      branches_finished: 2n,
    });
  } finally {
    first.resolve(helperAnswer);
    second.resolve(helperAnswer);
    await app.close();
  }
});

test('отказ перед отправкой во время паузы F9.1 сохраняет обращение без работы модели', async () => {
  const app = await fixture();
  try {
    const neighbor = await app.connectGroup(peer + 1);
    app.complete.mockResolvedValueOnce({ kind: 'error', code: 'rate_limit', message: 'Сбой' });
    const first = app.submit(mention);
    expect((await app.trace(first)).payload.resultKind).toBe('rate_limit');
    const paused = app.submit(mention, 41, undefined, peer + 1);
    expect((await app.trace(paused, 1_800, peer + 1)).payload.resultKind).toBe(
      'llm_provider_paused',
    );
    expect(totals(app.storage, app.scope, 'main')).toMatchObject({
      steps: 1n,
      attempts: 1n,
      errors: 1n,
    });
    expect(requests(app.storage, neighbor)?.requests).toBe(1n);
    expect(totals(app.storage, neighbor, 'main')).toBeUndefined();
    expect(app.complete).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test(
  'из ста сообщений учитываются три обращения, дубль и отказ по квоте разделены по беседам',
  { timeout: 20_000 },
  async () => {
    const app = await fixture({ userRequests: 1 });
    try {
      const neighbor = await app.connectGroup(peer + 1);
      app.at(1_000);
      const messages = app.db
        .prepare("SELECT count(*) FROM messages WHERE chat_id=? AND role='user'")
        .pluck();
      for (let i = 0; i < 97; i++) app.submit(`Реплика ${i}`);
      await vi.waitFor(() => expect(messages.get(app.scope.chatId)).toBe(97), {
        interval: 10,
        timeout: 12_000,
      });
      const first = app.submit(mention);
      await app.published(first);
      app.replay(first);
      const denied = app.submit(mention);
      expect((await app.trace(denied)).payload.resultKind).toBe('quota_exhausted');
      app.complete.mockResolvedValueOnce({
        kind: 'error',
        code: 'authentication',
        message: 'Сбой',
      });
      const failed = app.submit(mention, 42);
      expect((await app.trace(failed)).payload.resultKind).toBe('error');
      await app.published(app.submit(mention, 41, undefined, peer + 1));
      expect(requests(app.storage, app.scope)).toMatchObject({
        requests: 3n,
        quota_denied: 1n,
        wait_count: 3n,
        process_count: 3n,
      });
      expect(requests(app.storage, neighbor)).toMatchObject({
        requests: 1n,
        quota_denied: 0n,
        wait_count: 1n,
        process_count: 1n,
      });
      expect(app.complete).toHaveBeenCalledTimes(3);
      expect(
        app.db
          .prepare("SELECT count(*) FROM messages WHERE chat_id=? AND role='user'")
          .pluck()
          .get(app.scope.chatId),
      ).toBe(100);
    } finally {
      await app.close();
    }
  },
);

const route = () =>
  ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }) as const;
const day = Date.UTC(2026, 10, 24);

test('переполнение сохраняет обращение, у истечения в очереди есть только замер ожидания', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(day);
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: day });
  const first = Promise.withResolvers<'completed'>();
  const queue = createChatQueue({
    storage,
    tracing: { messageRetentionDays: 30 },
    config: { maxQueuedPerChat: 1, maxQueueAgeMs: 1_000 },
    handler: () => first.promise,
  });
  const submit = (n: number) =>
    queue.admitRouted(scope, queueMessage(scope.chatId, String(n)), route);
  try {
    await queue.start();
    expect((await submit(1)).admission.status).toBe('queued');
    await flushQueue();
    await vi.advanceTimersByTimeAsync(100);
    expect((await submit(2)).admission.status).toBe('queued');
    expect((await submit(3)).admission.status).toBe('queue_full');
    await vi.advanceTimersByTimeAsync(1_900);
    first.resolve('completed');
    await flushQueue();
    expect(requests(storage, scope)).toMatchObject({
      requests: 3n,
      queue_full: 1n,
      expired: 1n,
      wait_count: 2n,
      wait_ms: 1_000n,
      process_count: 1n,
      process_ms: 2_000n,
    });
  } finally {
    first.resolve('completed');
    await queue.stop();
    await storage.close();
    vi.useRealTimers();
  }
});

test('восстановление очереди завершает работу без замера времени обработки', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(day);
  const storage = await openStorage(':memory:');
  try {
    const scope = scopeFor(storage, 'vk:chat');
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: day });
    const queue = queueBackend(storage);
    queue.acquire('old', 1000, 1);
    queue.admitRouted('old', scope, queueMessage(scope.chatId, '1'), route, queueConfig());
    clock.mockReturnValue(day + 60);
    expect(queue.take('old')?.id).toBeDefined();
    clock.mockReturnValue(day + 1000);
    expect(queue.acquire('new', 1000, 1)).toBe(1);
    queue.release('new');
    expect(queue.acquire('next', 1000, 1)).toBe(0);
    expect(requests(storage, scope)).toMatchObject({
      requests: 1n,
      wait_count: 1n,
      wait_ms: 60n,
      interrupted: 1n,
      process_count: 0n,
    });
  } finally {
    await storage.close();
    clock.mockRestore();
  }
});
