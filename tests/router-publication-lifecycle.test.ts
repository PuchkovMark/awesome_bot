import { expect, test, vi } from 'vitest';
import { openStorage } from '../src/storage/index';
import { createChatQueue } from '../src/core/chat-queue/service';
import { scopeFor } from './helpers/connection-scope';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createPublicationService } from '../src/core/message-router/publication-service';
const route = { kind: 'name', mode: 'normal', isGroupChat: true } as const;
test('terminal зафиксирован до публикации; один чат не перекрывается, зависший порт ограничен и stop освобождает', async () => {
  vi.useFakeTimers();
  const storage = await openStorage(':memory:'),
    scope = scopeFor(storage, 'vk:a');
  await storage.chats.create(scope, { responseMode: 'normal', enabled: true, createdAt: 0 });
  const handler = vi.fn(async () => 'completed' as const);
  const onSettled = vi.fn(async () => {
    expect((await storage.queue.get(scope, 1))?.state).toBe('terminal');
    await new Promise(() => {});
  });
  const q = createChatQueue({ tracing: { messageRetentionDays: 30 }, storage, handler, onSettled });
  try {
    await q.start();
    await q.admitRouted(scope, queueMessage('vk:a', '1'), () => ({ reason: 'name', route }));
    await flushQueue();
    await q.admitRouted(scope, queueMessage('vk:a', '2'), () => ({ reason: 'name', route }));
    await flushQueue();
    expect(handler).toHaveBeenCalledOnce();
    await q.stop();
    expect(q.signal.aborted).toBe(true);
    expect(q.isRunning()).toBe(false);
  } finally {
    await storage.close();
    vi.useRealTimers();
  }
});
test('поздний результат после deadline не вызывает порт', async () => {
  vi.useFakeTimers();
  const storage = await openStorage(':memory:'),
    scope = scopeFor(storage, 'vk:a');
  let resolve: (x: 'completed') => void = () => {};
  const onSettled = vi.fn(async () => {});
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: () =>
      new Promise((r) => {
        resolve = r;
      }),
    onSettled,
  });
  try {
    await q.start();
    await q.admit(scope, queueMessage('vk:a', '1'), () => true);
    await flushQueue();
    await vi.advanceTimersByTimeAsync(130000);
    resolve('completed');
    await flushQueue();
    expect(onSettled).not.toHaveBeenCalled();
    expect(await storage.queue.get(scope, 1)).toMatchObject({ outcome: 'deadline_exceeded' });
  } finally {
    await q.stop();
    await storage.close();
    vi.useRealTimers();
  }
});
test('новое поколение во время canReply не получает старую отправку', async () => {
  const storage = await openStorage(':memory:'),
    scope = scopeFor(storage, 'vk:a');
  await storage.chats.create(scope, { responseMode: 'normal', enabled: true, createdAt: 0 });
  const m = await storage.messages.append(scope, queueMessage('vk:a', '1'));
  let release: (x: boolean) => void = () => {};
  const publish = vi.fn(async () => ({ kind: 'unknown' as const }));
  const service = createPublicationService({
    storage,
    port: {
      canReply: () =>
        new Promise((r) => {
          release = r;
        }),
      publish,
    },
  });
  const pending = service.queueFull(scope, m.id, route, {
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  await flushQueue();
  const life = lifecycleBackend(storage);
  life.ownerDecision(life.begin(scope.chatId), 'new');
  release(true);
  await pending;
  expect(publish).not.toHaveBeenCalled();
  await storage.close();
});
test('выключение отменяет уже ожидающий порт и освобождает слот до общего срока', async () => {
  vi.useFakeTimers();
  const storage = await openStorage(':memory:'),
    scope = scopeFor(storage, 'vk:a');
  await storage.chats.create(scope, { responseMode: 'normal', enabled: true, createdAt: 0 });
  let signal: AbortSignal | undefined;
  const q = createChatQueue({
    tracing: { messageRetentionDays: 30 },
    storage,
    handler: async () => 'completed',
    onSettled: async (work) => {
      signal = work.signal;
      await new Promise(() => {});
    },
  });
  try {
    await q.start();
    await q.admitRouted(scope, queueMessage('vk:a', '1'), () => ({ reason: 'name', route }));
    await flushQueue();
    expect(signal?.aborted).toBe(false);
    await storage.chats.update(scope, { enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(signal?.aborted).toBe(true);
    expect(q.isRunning()).toBe(true);
  } finally {
    await q.stop();
    await storage.close();
    vi.useRealTimers();
  }
});
