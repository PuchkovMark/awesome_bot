import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openStorage } from '../src/storage/index';
import { createChatQueue } from '../src/core/index';
import { scopeFor } from './helpers/connection-scope';
import { queueMessage, flushQueue } from './helpers/chat-queue';
import { queueBackend } from '../src/storage/queue-registry';
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => vi.useRealTimers());
test('ограниченная остановка игнорирующего сигнал обработчика, queued сохранено, поздний отказ наблюдается', async () => {
  const storage = await openStorage(':memory:'),
    scope = scopeFor(storage, 'vk:a');
  let reject!: (error: unknown) => void;
  let signal!: AbortSignal;
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: (w) => {
      signal = w.signal;
      return new Promise((_, r) => {
        reject = r;
      });
    },
  });
  try {
    await q.start();
    await q.admit(scope, queueMessage('vk:a', '1'), () => true);
    await flushQueue();
    await q.admit(scope, queueMessage('vk:a', '2'), () => true);
    const p = q.stop();
    expect(q.stop()).toBe(p);
    expect((await q.admit(scope, queueMessage('vk:a', '3'), () => true)).status).toBe('stopped');
    await vi.advanceTimersByTimeAsync(9999);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(signal.aborted).toBe(true);
    expect(q.stats()).toMatchObject({ interrupted: 1, depthQueued: 1, depthRunning: 0 });
    reject(Error('private'));
    await flushQueue();
    expect(q.stats().interrupted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    queueBackend(storage).acquire('next', 1000, 100);
    queueBackend(storage).release('next');
  } finally {
    await q.stop();
    await storage.close();
  }
});
test('нет задач: остановка освобождает таймеры; обычное завершение не заменяется прерыванием', async () => {
  const storage = await openStorage(':memory:');
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: async () => 'completed',
  });
  try {
    await q.start();
    await q.stop();
    await q.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(q.stats().interrupted).toBe(0);
  } finally {
    await storage.close();
  }
});

test('владение сохраняется для принятого входа после окончания срока работающих заданий', async () => {
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:a');
  const handler = vi.fn(async () => 'completed' as const);
  const options = { storage, handler, tracing: { messageRetentionDays: 30 } };
  const q = createChatQueue(options);
  const drain = new AbortController();
  try {
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    await q.start();
    const accepted = q.registerInput(scope.chatId, scope, () => true)!;
    const stale = q.registerInput(scope.chatId, scope, () => false)!;
    const registerOnStop = vi.fn(() => q.registerInput(scope.chatId, scope, () => true));
    q.signal.addEventListener('abort', registerOnStop, { once: true });
    const stopping = q.stop(drain.signal);
    expect(registerOnStop).toHaveReturnedWith(undefined);
    const decide = () =>
      ({
        route: { kind: 'name', mode: 'normal', isGroupChat: true },
        reason: 'name',
      }) as const;
    await vi.advanceTimersByTimeAsync(11_000);
    expect(q.registerInput(scope.chatId, scope, () => true)).toBeUndefined();
    expect(
      (await q.admitRouted(scope, queueMessage(scope.chatId, 'fresh'), decide)).admission.status,
    ).toBe('stopped');
    expect(
      (
        await q.admitRouted(
          scope,
          queueMessage(scope.chatId, 'stale'),
          decide,
          undefined,
          undefined,
          stale,
        )
      ).admission.status,
    ).toBe('paused');
    const message = queueMessage(scope.chatId, 'before-stop');
    const admission = await q.admitRouted(scope, message, decide, undefined, undefined, accepted);
    expect(admission.admission.status).toBe('queued');
    expect(
      (await q.admitRouted(scope, message, decide, undefined, undefined, accepted)).admission
        .status,
    ).toBe('duplicate');
    expect((await storage.messages.list(scope, { limit: 10 })).map((row) => row.messageId)).toEqual(
      ['before-stop'],
    );
    await expect(createChatQueue(options).start()).rejects.toMatchObject({ code: 'owned' });
    expect(handler).not.toHaveBeenCalled();
    accepted.complete();
    stale.complete();
    await stopping;
    if (admission.admission.status === 'queued')
      expect(await storage.queue.get(scope, admission.admission.jobId)).toMatchObject({
        state: 'queued',
      });
    const next = createChatQueue(options);
    await next.start();
    await flushQueue();
    expect(handler).toHaveBeenCalledOnce();
    await next.stop();
  } finally {
    drain.abort();
    await q.stop();
    await storage.close();
  }
});
test('при закрытой БД stop отказывает конечной безопасной ошибкой', async () => {
  const storage = await openStorage(':memory:');
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: async () => 'completed',
  });
  await q.start();
  await storage.close();
  await expect(q.stop()).rejects.toMatchObject({ code: 'storage_failed' });
  expect(vi.getTimerCount()).toBe(0);
});
