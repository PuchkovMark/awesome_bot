import { expect, test, vi } from 'vitest';
import type { ConnectionScope } from '../src/contracts/index';
import { createChatQueue } from '../src/core/index';
import { queueConfig } from '../src/core/chat-queue/validation';
import { chatRequestMetricsStore } from '../src/storage/chat-request-metrics-store';
import { openStorage } from '../src/storage/index';
import { queueBackend } from '../src/storage/queue-registry';
import type { Storage } from '../src/storage/types';
import { fixture, mention, peer } from './helpers/application-response-fixture';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { scopeFor } from './helpers/connection-scope';

function requests(storage: Storage, scope: ConnectionScope) {
  return chatRequestMetricsStore(storage)
    .read(scope, 'day', 0, Date.now())
    .buckets.find((row) => row.series === 'requests')?.totals;
}

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
