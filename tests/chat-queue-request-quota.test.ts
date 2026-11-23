import { expect, test, vi } from 'vitest';
import { tokenBudgetStore } from '../src/storage/token-budget-store';
import { createAgentLoopQueue } from '../src/core/index';
import type { LlmResult } from '../src/llm/types';
import { openStorage } from '../src/storage/index';
import { flushQueue, queueMessage } from './helpers/chat-queue';
import { scopeFor } from './helpers/connection-scope';

const route = () =>
  ({ reason: 'mention', route: { kind: 'mention', mode: 'normal', isGroupChat: true } }) as const;
const ready = {
  kind: 'ready',
  input: {
    system: '',
    messages: [{ role: 'user', text: 'Тест' }],
    maxOutputTokens: 1,
    sessionId: 'test',
  },
} as const;
const response = {
  kind: 'complete',
  text: 'Синтетический ответ',
  usage: { input: 1, output: 1 },
} as const;
const limits = { userRequests: 1, chatRequests: 1 };

test('переполнение, отмена и ошибка подготовки оставляют место первой допустимой попытке', async () => {
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<typeof ready>();
  const complete = vi.fn(async () => response);
  const queue = createAgentLoopQueue({
    storage,
    limits,
    config: { maxQueuedPerChat: 1 },
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    client: { complete },
    async prepare(work) {
      const row = await storage.messages.get(work.scope, work.messageId);
      if (row?.messageId === '1') {
        started.resolve();
        return release.promise;
      }
      if (row?.messageId === '4') return { kind: 'failed', reason: 'current_message_too_large' };
      return ready;
    },
  });
  const enqueue = async (id: string) =>
    (await queue.admitRouted(scope, queueMessage(scope.chatId, id), route)).admission;
  const finished = (jobId: number, outcome: string) =>
    vi.waitFor(async () => {
      expect(await storage.queue.get(scope, jobId)).toMatchObject({ state: 'terminal', outcome });
    });
  try {
    await queue.start();
    expect(await enqueue('1')).toMatchObject({ status: 'queued', jobId: 1 });
    await started.promise;
    expect(await enqueue('2')).toMatchObject({ status: 'queued', jobId: 2 });
    expect(await enqueue('3')).toMatchObject({ status: 'queue_full' });
    await storage.chats.update(scope, { responseMode: 'silent' });
    await storage.chats.update(scope, { responseMode: 'normal' });
    release.resolve(ready);
    await finished(1, 'interrupted');
    await finished(2, 'interrupted');
    expect(await enqueue('4')).toMatchObject({ status: 'queued', jobId: 3 });
    await finished(3, 'failed');
    expect(await enqueue('5')).toMatchObject({ status: 'queued', jobId: 4 });
    await finished(4, 'completed');
    expect(await enqueue('6')).toMatchObject({ status: 'queued', jobId: 5 });
    await finished(5, 'failed');
    expect(complete).toHaveBeenCalledTimes(1);
    expect((await storage.traces.get(scope, 5))?.payload).toMatchObject({
      resultKind: 'quota_exhausted',
      model: { invoked: 'no' },
      summary: { attempts: 0 },
    });
    expect((await storage.messages.list(scope, { limit: 10 })).map((row) => row.messageId)).toEqual(
      ['1', '2', '3', '4', '5', '6'],
    );
  } finally {
    release.resolve(ready);
    await queue.stop();
    await storage.close();
  }
});

test('повтор модели разрешён при занятой квоте, а тайм-аут сохраняет списание', async () => {
  vi.useFakeTimers();
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
  const complete = vi
    .fn<() => Promise<LlmResult>>()
    .mockResolvedValueOnce({ kind: 'error', code: 'server', message: 'Синтетический сбой' })
    .mockImplementation(() => new Promise(() => {}));
  const queue = createAgentLoopQueue({
    storage,
    limits,
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    client: { complete },
    prepare: async () => ready,
    loopOptions: { retryDelayMs: 5, timeoutMs: 100 },
  });
  try {
    await queue.start();
    await queue.admitRouted(scope, queueMessage(scope.chatId, '1'), route);
    await flushQueue();
    expect(complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5);
    expect(complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(95);
    expect(await storage.queue.get(scope, 1)).toMatchObject({ outcome: 'deadline_exceeded' });
    await queue.admitRouted(scope, queueMessage(scope.chatId, '2'), route);
    await flushQueue();
    expect((await storage.traces.get(scope, 2))?.payload).toMatchObject({
      resultKind: 'quota_exhausted',
      summary: { attempts: 0 },
    });
    expect(complete).toHaveBeenCalledTimes(2);
  } finally {
    await queue.stop();
    await storage.close();
    vi.useRealTimers();
  }
});

test('отказ токен-бюджета и отказ F4.3 не расходуют второй лимит', async () => {
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  const budget = tokenBudgetStore(storage);
  const needed = 128 + 32 + Buffer.byteLength('Тест') + ready.input.maxOutputTokens;
  const complete = vi.fn(async () => response);
  const queue = createAgentLoopQueue({
    storage,
    limits,
    tokenBudget: true,
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    client: { complete },
    prepare: async () => ready,
  });
  const run = async (id: number) => {
    await queue.admitRouted(scope, queueMessage(scope.chatId, String(id)), route);
    await flushQueue();
    return (await storage.traces.get(scope, id))?.payload.resultKind;
  };
  try {
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    await queue.start();
    budget.update(scope, true, { total: needed - 1 }, Date.now());
    expect(await run(1)).toBe('token_budget_exhausted');
    expect(complete).not.toHaveBeenCalled();
    expect(budget.read(scope, true, Date.now()).total.reserved).toBe(0n);

    budget.update(scope, true, { total: needed }, Date.now());
    expect(await run(2)).toBe('complete');
    expect(complete).toHaveBeenCalledOnce();
    const used = budget.read(scope, true, Date.now()).total;

    budget.update(scope, true, { total: needed * 3 }, Date.now());
    expect(await run(3)).toBe('quota_exhausted');
    const after = budget.read(scope, true, Date.now()).total;
    expect(after.confirmed).toBe(used.confirmed);
    expect(after.reserved).toBe(used.reserved);
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    await queue.stop();
    await storage.close();
  }
});

test('поздний usage после тайм-аута сохраняется без повторного вызова', async () => {
  vi.useFakeTimers();
  const storage = await openStorage(':memory:');
  const scope = scopeFor(storage, 'vk:chat');
  const budget = tokenBudgetStore(storage);
  const delayed = Promise.withResolvers<LlmResult>();
  const complete = vi.fn(() => delayed.promise);
  const queue = createAgentLoopQueue({
    storage,
    tokenBudget: true,
    tracing: { messageRetentionDays: 30 },
    modelName: 'synthetic',
    client: { complete },
    prepare: async () => ready,
    loopOptions: { timeoutMs: 100 },
  });
  try {
    await storage.chats.create(scope, { enabled: true, responseMode: 'normal', createdAt: 0 });
    await queue.start();
    await queue.admitRouted(scope, queueMessage(scope.chatId, '1'), route);
    await flushQueue();
    await vi.advanceTimersByTimeAsync(100);
    expect(await storage.queue.get(scope, 1)).toMatchObject({ outcome: 'deadline_exceeded' });
    expect(budget.read(scope, true, Date.now()).total.incompleteAttempts).toBe(1);
    delayed.resolve({ ...response, usage: { input: 600, output: 0 } });
    await flushQueue();
    expect(budget.read(scope, true, Date.now()).total).toMatchObject({
      confirmed: 600n,
      reserved: 0n,
      incompleteAttempts: 0,
    });
    expect(complete).toHaveBeenCalledOnce();
  } finally {
    await queue.stop();
    await storage.close();
    vi.useRealTimers();
  }
});
