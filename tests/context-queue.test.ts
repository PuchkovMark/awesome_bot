import { lifecycleBackend } from '../src/storage/lifecycle-store';
import { createContextBuilder } from '../src/core/context/index';
import { expect, test, vi } from 'vitest';
import { contextFixture } from './helpers/context';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { createAgentLoopQueue } from '../src/core/chat-queue/agent-loop-adapter';
test('отказ подготовки не вызывает клиент и сохраняется отдельно от результата цикла', async () => {
  const f = await contextFixture();
  const complete = vi.fn();
  const settled = vi.fn();
  const q = createAgentLoopQueue({
    modelName: 'synthetic-model',
    tracing: { messageRetentionDays: 30 },
    storage: f.storage,
    client: { complete },
    prepare: async () => ({ kind: 'failed', reason: 'current_message_too_large' }),
    onSettled: settled,
  });
  try {
    await q.start();
    await q.admit(f.scope, queueMessage(f.scope.chatId, 'a'), () => true);
    await flushQueue();
    expect(complete).not.toHaveBeenCalled();
    expect(settled.mock.calls[0]?.[1]).toEqual({
      outcome: 'failed',
      preparationFailure: 'current_message_too_large',
    });
    expect(await f.storage.queue.get(f.scope, 1)).toMatchObject({
      state: 'terminal',
      outcome: 'failed',
    });
  } finally {
    await q.stop();
    await f.storage.close();
  }
});
test('выключение между подготовкой и циклом блокирует клиент непосредственно перед запуском', async () => {
  const f = await contextFixture();
  const complete = vi.fn();
  const q = createAgentLoopQueue({
    modelName: 'synthetic-model',
    tracing: { messageRetentionDays: 30 },
    storage: f.storage,
    client: { complete },
    prepare: async () => {
      await f.storage.chats.update(f.scope, { enabled: false });
      return {
        kind: 'ready',
        input: {
          system: '',
          messages: [{ role: 'user', text: 'x' }],
          maxOutputTokens: 1,
          sessionId: 'session',
        },
      };
    },
  });
  try {
    await q.start();
    await q.admit(f.scope, queueMessage(f.scope.chatId, 'a'), () => true);
    await flushQueue();
    expect(complete).not.toHaveBeenCalled();
    expect(await f.storage.queue.get(f.scope, 1)).toMatchObject({ outcome: 'interrupted' });
  } finally {
    await q.stop();
    await f.storage.close();
  }
});
test('зависший prepare имеет отдельный срок, просроченное ready не запускает модель', async () => {
  vi.useFakeTimers();
  const f = await contextFixture();
  const complete = vi.fn();
  let release: (v: never) => void = () => {};
  const q = createAgentLoopQueue({
    modelName: 'synthetic-model',
    tracing: { messageRetentionDays: 30 },
    storage: f.storage,
    client: { complete },
    preparationTimeoutMs: 5,
    prepare: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  });
  try {
    await q.start();
    await q.admit(f.scope, queueMessage(f.scope.chatId, 'a'), () => true);
    await flushQueue();
    await vi.advanceTimersByTimeAsync(5);
    expect(await f.storage.queue.get(f.scope, 1)).toMatchObject({ outcome: 'deadline_exceeded' });
    release({ kind: 'ready', input: {} } as never);
    await flushQueue();
    expect(complete).not.toHaveBeenCalled();
  } finally {
    await q.stop();
    await f.storage.close();
    vi.useRealTimers();
  }
});
test('реальное переподключение во время подготовки не передаёт старое задание клиенту', async () => {
  const f = await contextFixture();
  const complete = vi.fn();
  const life = lifecycleBackend(f.storage);
  const builder = createContextBuilder({
    ...f.options,
    capabilities: async () => {
      life.ownerDecision(life.begin(f.scope.chatId), 'new');
      return f.options.capabilities();
    },
  });
  const q = createAgentLoopQueue({
    modelName: 'synthetic-model',
    tracing: { messageRetentionDays: 30 },
    storage: f.storage,
    client: { complete },
    prepare: builder.prepare,
  });
  try {
    await q.start();
    await q.admitRouted(f.scope, queueMessage(f.scope.chatId, 'a'), () => ({
      reason: 'mention',
      route: { kind: 'mention', mode: 'normal', isGroupChat: true },
    }));
    await flushQueue();
    await flushQueue();
    expect(complete).not.toHaveBeenCalled();
    expect(life.current(f.scope.chatId).generation).not.toBe(f.scope.generation);
    expect(builder.stats().cancelled).toBe(1);
  } finally {
    await q.stop();
    await f.storage.close();
  }
});
